#!/bin/sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

contains() {
  case "$1" in
  *"$2"*) return 0 ;;
  *) return 1 ;;
  esac
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mount devtmpfs"
mkdir -p /dev/pts || fail "create /dev/pts"
mount -t devpts devpts /dev/pts || fail "mount devpts"
mount -t proc proc /proc || fail "mount proc"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

for ttymsg_run in 1 2 3; do
  ttymsg_result=$(/test_ttymsg) || fail "ttymsg slow terminal callback run $ttymsg_run"
  contains "$ttymsg_result" "payload=yes fd-leak=no" ||
    fail "ttymsg callback semantics run $ttymsg_run: $ttymsg_result"
done

script -q -c 'tty && test -t 0 && test -t 1 && test -t 2 && echo SCRIPT_MARKER' \
  -T /tmp/timing /tmp/typescript </dev/null >/tmp/script.out 2>/tmp/script.err
rc=$?
[ "$rc" -eq 0 ] || fail "script command failed (rc=$rc): $(cat /tmp/script.err)"

contains "$(cat /tmp/typescript)" "/dev/pts/" ||
  fail "typescript does not contain a devpts tty: $(cat /tmp/typescript)"
contains "$(cat /tmp/typescript)" "SCRIPT_MARKER" ||
  fail "typescript does not contain marker: $(cat /tmp/typescript)"
contains "$(cat /tmp/script.out)" "SCRIPT_MARKER" ||
  fail "script stdout does not contain marker: $(cat /tmp/script.out)"

# Drive irqtop's interactive quit path through a real PTY and verify that its
# normal exit restores the exact terminal mode it inherited.
printf '%s\n' '#!/bin/sh' \
  'before=$(stty -g) || exit 91' \
  'irqtop -d 10' \
  'rc=$?' \
  'after=$(stty -g) || exit 92' \
  '[ "$before" = "$after" ] || exit 93' \
  'echo IRQTOP_TTY_RESTORED' \
  'exit "$rc"' \
  > /tmp/irqtop-wrapper || fail "create irqtop wrapper"
chmod +x /tmp/irqtop-wrapper || fail "make irqtop wrapper executable"
printf q | timeout 5 script -q -e -c 'TERM=xterm /tmp/irqtop-wrapper' \
  /tmp/irqtop.typescript >/tmp/irqtop.out 2>/tmp/irqtop.err
irqtop_rc=$?
[ "$irqtop_rc" -eq 0 ] ||
  fail "irqtop interactive q status $irqtop_rc: $(cat /tmp/irqtop.err)"
contains "$(cat /tmp/irqtop.typescript)" IRQTOP_TTY_RESTORED ||
  fail "irqtop interactive q did not restore its tty"

# Drive more through a real PTY. Its child command paths must return to the
# pager, and every exit path must restore the terminal mode seen by its shell.
seq 1 200 >/tmp/more-input || fail "create more fixture"
printf '%s\n' '#!/bin/sh' \
  '{ printf "PID:%s\nARGS:%s\n" "$$" "$*"; awk '\''/^SigBlk:/ { print "MASK:" $2 }'\'' /proc/self/status; } >/tmp/more-shell.marker' \
  > /tmp/more-fake-shell || fail "create fake more shell"
printf '%s\n' '#!/bin/sh' \
  'printf "PID:%s\nARGS:%s\n" "$$" "$*" >/tmp/more-editor.marker' \
  > /tmp/more-fake-editor || fail "create fake more editor"
printf '%s\n' '#!/bin/sh' \
  'before=$(stty -g) || exit 91' \
  'more /tmp/more-input' \
  'rc=$?' \
  'after=$(stty -g) || exit 92' \
  '[ "$before" = "$after" ] || exit 93' \
  'echo MORE_TTY_RESTORED' \
  'exit "$rc"' \
  > /tmp/more-wrapper || fail "create more wrapper"
chmod +x /tmp/more-fake-shell /tmp/more-fake-editor /tmp/more-wrapper ||
  fail "make more helpers executable"

find_more_pid() {
  for comm in /proc/[0-9]*/comm; do
    [ "$(cat "$comm" 2>/dev/null)" = more ] || continue
    pid=${comm#/proc/}
    printf '%s\n' "${pid%%/*}"
    return 0
  done
  return 1
}

rm -f /tmp/more-shell.marker /tmp/more-editor.marker /tmp/more-command.in
mkfifo /tmp/more-command.in || fail "create more command fifo"
SHELL=/bin/sh script -q -c \
  'TERM=xterm SHELL=/tmp/more-fake-shell VISUAL=/tmp/more-fake-editor /tmp/more-wrapper' \
  /tmp/more-command.typescript </tmp/more-command.in >/tmp/more-command.out 2>&1 &
more_session=$!
exec 3>/tmp/more-command.in
i=0
while ! contains "$(cat /tmp/more-command.out 2>/dev/null)" "--More--" &&
    [ "$i" -lt 200 ]; do sleep .05; i=$((i + 1)); done
[ "$i" -lt 200 ] || fail "more command prompt readiness"
more_pid=$(find_more_pid) || fail "locate more command process"
old_size=$(wc -c </tmp/more-command.out)
printf '!' >&3
i=0
while [ "$(wc -c </tmp/more-command.out)" -le "$old_size" ] &&
    [ "$i" -lt 100 ]; do sleep .05; i=$((i + 1)); done
[ "$i" -lt 100 ] || fail "more shell input readiness"
printf 'marker-command\n' >&3
i=0
while [ ! -s /tmp/more-shell.marker ] && [ "$i" -lt 200 ]; do sleep .05; i=$((i + 1)); done
[ -s /tmp/more-shell.marker ] || fail "more shell callback"
contains "$(cat /tmp/more-shell.marker)" "ARGS:-c marker-command" ||
  fail "more shell argv: $(cat /tmp/more-shell.marker)"
child_mask=$(awk -F: '$1 == "MASK" { print $2 }' /tmp/more-shell.marker)
for child_signal in INT QUIT TSTP CONT WINCH; do
  signal_number=$(kill -l "$child_signal") || fail "resolve $child_signal"
  signal_bit=$((1 << (signal_number - 1)))
  [ $(((0x$child_mask) & signal_bit)) -ne 0 ] ||
    fail "more command child unblocked $child_signal (SigBlk=$child_mask)"
done
i=0
command_pid=$(awk -F: '$1 == "PID" { print $2 }' /tmp/more-shell.marker)
[ -n "$command_pid" ] || fail "more shell callback PID"
while [ -e "/proc/$command_pid" ] && [ "$i" -lt 100 ]; do
  sleep .05
  i=$((i + 1))
done
[ "$i" -lt 100 ] || fail "more did not reap shell callback"
printf 'v' >&3
i=0
while [ ! -s /tmp/more-editor.marker ] && [ "$i" -lt 200 ]; do sleep .05; i=$((i + 1)); done
[ -s /tmp/more-editor.marker ] || fail "more editor callback"
contains "$(cat /tmp/more-editor.marker)" "/tmp/more-input" ||
  fail "more editor argv: $(cat /tmp/more-editor.marker)"
i=0
editor_pid=$(awk -F: '$1 == "PID" { print $2 }' /tmp/more-editor.marker)
[ -n "$editor_pid" ] || fail "more editor callback PID"
while [ -e "/proc/$editor_pid" ] && [ "$i" -lt 100 ]; do
  sleep .05
  i=$((i + 1))
done
[ "$i" -lt 100 ] || fail "more did not reap editor callback"
printf 'q' >&3
exec 3>&-
(sleep 10; kill -KILL "$more_session" 2>/dev/null) &
watchdog=$!
wait "$more_session"
more_rc=$?
kill "$watchdog" 2>/dev/null || true
[ "$more_rc" -eq 0 ] || fail "more shell/editor session status $more_rc"
contains "$(cat /tmp/more-command.typescript)" MORE_TTY_RESTORED ||
  fail "more did not resume and restore tty after child commands"

# QUIT is advisory on first delivery; WINCH must leave paging alive; TSTP is
# mirrored as a real stopped process and CONT resumes paging.
rm -f /tmp/more-signal.in
mkfifo /tmp/more-signal.in || fail "create more signal fifo"
SHELL=/bin/sh script -q -c 'TERM=xterm /tmp/more-wrapper' \
  /tmp/more-signal.typescript </tmp/more-signal.in >/tmp/more-signal.out 2>&1 &
more_session=$!
exec 3>/tmp/more-signal.in
i=0
while ! contains "$(cat /tmp/more-signal.out 2>/dev/null)" "--More--" &&
    [ "$i" -lt 200 ]; do sleep .05; i=$((i + 1)); done
[ "$i" -lt 200 ] || fail "more signal prompt readiness"
more_pid=$(find_more_pid) || fail "locate more signal process"
kill -QUIT "$more_pid" || fail "signal more QUIT"
i=0
while ! contains "$(cat /tmp/more-signal.out)" "Use q or Q to quit" &&
    [ "$i" -lt 100 ]; do sleep .05; i=$((i + 1)); done
[ "$i" -lt 100 ] || fail "more QUIT advisory behavior"
kill -WINCH "$more_pid" || fail "signal more WINCH"
# Stress the kernel's stop/continue cancellation rule. A queued CONT must
# cancel an as-yet-undispatched TSTP rather than leave the pager stopped.
i=0
while [ "$i" -lt 20 ]; do
  kill -TSTP "$more_pid" || fail "rapid signal more TSTP"
  kill -CONT "$more_pid" || fail "rapid signal more CONT"
  i=$((i + 1))
done
sleep .1
awk '$1 == "State:" && $2 == "T" { found = 1 } END { exit found }' \
  "/proc/$more_pid/status" 2>/dev/null || fail "more retained cancelled TSTP"
kill -TSTP "$more_pid" || fail "signal more TSTP"
i=0
while ! awk '$1 == "State:" && $2 == "T" { found = 1 } END { exit !found }' \
    "/proc/$more_pid/status" 2>/dev/null && [ "$i" -lt 100 ]; do
  sleep .05
  i=$((i + 1))
done
[ "$i" -lt 100 ] || fail "more did not stop on TSTP"
kill -CONT "$more_pid" || fail "signal more CONT"
i=0
while awk '$1 == "State:" && $2 == "T" { found = 1 } END { exit !found }' \
    "/proc/$more_pid/status" 2>/dev/null && [ "$i" -lt 100 ]; do
  sleep .05
  i=$((i + 1))
done
[ "$i" -lt 100 ] || fail "more did not resume on CONT"
printf 'q' >&3
exec 3>&-
(sleep 10; kill -KILL "$more_session" 2>/dev/null) &
watchdog=$!
wait "$more_session"
more_rc=$?
kill "$watchdog" 2>/dev/null || true
[ "$more_rc" -eq 0 ] || fail "more signal session status $more_rc"
contains "$(cat /tmp/more-signal.typescript)" MORE_TTY_RESTORED ||
  fail "more signal session did not restore tty"

# INT follows the pager's normal clean-exit path and also restores the tty.
rm -f /tmp/more-int.in
mkfifo /tmp/more-int.in || fail "create more INT fifo"
SHELL=/bin/sh script -q -c 'TERM=xterm /tmp/more-wrapper' \
  /tmp/more-int.typescript </tmp/more-int.in >/tmp/more-int.out 2>&1 &
more_session=$!
exec 3>/tmp/more-int.in
i=0
while ! contains "$(cat /tmp/more-int.out 2>/dev/null)" "--More--" &&
    [ "$i" -lt 200 ]; do sleep .05; i=$((i + 1)); done
[ "$i" -lt 200 ] || fail "more INT prompt readiness"
more_pid=$(find_more_pid) || fail "locate more INT process"
kill -INT "$more_pid" || fail "signal more INT"
exec 3>&-
(sleep 10; kill -KILL "$more_session" 2>/dev/null) &
watchdog=$!
wait "$more_session"
more_rc=$?
kill "$watchdog" 2>/dev/null || true
[ "$more_rc" -eq 0 ] || fail "more INT session status $more_rc"
contains "$(cat /tmp/more-int.typescript)" MORE_TTY_RESTORED ||
  fail "more INT path did not restore tty"

# While the proxy is active it must retain upstream's all-signals-blocked
# model, unblocking only the signals serviced by the self-pipe bridge.
rm -f /tmp/pty-mask.pid /tmp/pty-mask.release
script -q -c \
  'echo "$PPID" >/tmp/pty-mask.pid; i=0; while [ ! -e /tmp/pty-mask.release ] && [ "$i" -lt 200 ]; do sleep .05; i=$((i + 1)); done; test -e /tmp/pty-mask.release && echo PTY_MASK_RELEASED' \
  /tmp/mask.typescript </dev/null >/tmp/mask.out 2>&1 &
mask_script=$!
i=0
while [ ! -s /tmp/pty-mask.pid ] && [ "$i" -lt 100 ]; do sleep .05; i=$((i + 1)); done
[ -s /tmp/pty-mask.pid ] || fail "PTY proxy mask readiness"
mask_proxy=$(cat /tmp/pty-mask.pid)
blocked=$(awk '/^SigBlk:/ { print $2 }' "/proc/$mask_proxy/status") ||
  fail "read PTY proxy signal mask"
usr2=$(kill -l USR2) || fail "resolve SIGUSR2"
usr2_bit=$((1 << (usr2 - 1)))
[ $(((0x$blocked) & usr2_bit)) -ne 0 ] ||
  fail "PTY proxy unexpectedly unblocked SIGUSR2 (SigBlk=$blocked)"
touch /tmp/pty-mask.release
(sleep 10; kill -KILL "$mask_script" 2>/dev/null) &
watchdog=$!
wait "$mask_script"
mask_rc=$?
kill "$watchdog" 2>/dev/null || true
[ "$mask_rc" -eq 0 ] || fail "PTY proxy mask test status $mask_rc"
contains "$(cat /tmp/mask.typescript)" PTY_MASK_RELEASED ||
  fail "PTY proxy mask child did not complete"

# The callback child must receive the caller's original mask and dispositions,
# not the bridge handlers or its temporarily blocked setup mask.
trap '' USR1
script -q -c \
  'kill -USR1 $$; grep -q "^SigBlk:[[:space:]]*0000000000000000$" /proc/self/status && echo PTY_SIGNAL_RESTORE' \
  /tmp/signal-restore.typescript </dev/null >/tmp/signal-restore.out 2>&1
restore_rc=$?
trap - USR1
[ "$restore_rc" -eq 0 ] || fail "PTY child signal restoration rc=$restore_rc"
contains "$(cat /tmp/signal-restore.typescript)" PTY_SIGNAL_RESTORE ||
  fail "PTY child inherited bridge signal state"

# A stopped child remains owned and is resumed rather than being mistaken for
# an exited child by coalesced SIGCHLD processing.
rm -f /tmp/pty-stop.pid
script -q -c \
  'echo $$ >/tmp/pty-stop.pid; kill -STOP $$; echo PTY_STOP_CONT' \
  /tmp/stop-cont.typescript </dev/null >/tmp/stop-cont.out 2>&1 &
script_parent=$!
i=0
while [ ! -s /tmp/pty-stop.pid ] && [ "$i" -lt 100 ]; do sleep .05; i=$((i + 1)); done
[ -s /tmp/pty-stop.pid ] || fail "PTY stopped child readiness"
# script deliberately mirrors the child's SIGSTOP onto itself; once its
# parent is resumed, its callback resumes the managed PTY child.
i=0
while ! awk '$1 == "State:" && $2 == "T" { found = 1 } END { exit !found }' \
    "/proc/$script_parent/status" 2>/dev/null && [ "$i" -lt 100 ]; do
  sleep .05
  i=$((i + 1))
done
awk '$1 == "State:" && $2 == "T" { found = 1 } END { exit !found }' \
  "/proc/$script_parent/status" 2>/dev/null || fail "PTY parent did not mirror SIGSTOP"
kill -CONT "$script_parent" || fail "resume PTY proxy parent"
(sleep 10; kill -KILL "$script_parent" 2>/dev/null) &
watchdog=$!
wait "$script_parent"
stop_rc=$?
kill "$watchdog" 2>/dev/null || true
[ "$stop_rc" -eq 0 ] || fail "PTY STOP/CONT status $stop_rc"
contains "$(cat /tmp/stop-cont.typescript)" PTY_STOP_CONT ||
  fail "PTY child did not resume after SIGSTOP"

# --ctty must run TIOCSCTTY after setsid in the callback child.  The command's
# stdin remains its controlling terminal and it remains the session leader.
script -q -c \
  'setsid --fork --wait --ctty sh -c '\''test -t 0 && read -r p _ _ _ _ s _ </proc/self/stat && test "$p" = "$s" && echo SETSID_CTTY_MARKER'\''' \
  /tmp/setsid-typescript </dev/null >/tmp/setsid.out 2>/tmp/setsid.err
rc=$?
[ "$rc" -eq 0 ] || fail "setsid --ctty failed (rc=$rc): $(cat /tmp/setsid.err)"
contains "$(cat /tmp/setsid-typescript)" "SETSID_CTTY_MARKER" ||
  fail "setsid --ctty did not preserve controlling tty/session leadership"

scriptreplay -T /tmp/timing -O /tmp/typescript >/tmp/replay.out 2>/tmp/replay.err
rc=$?
[ "$rc" -eq 0 ] || fail "scriptreplay failed (rc=$rc): $(cat /tmp/replay.err)"
contains "$(cat /tmp/replay.out)" "SCRIPT_MARKER" ||
  fail "scriptreplay output does not contain marker: $(cat /tmp/replay.out)"

echo "script PTY capture and scriptreplay verified"
echo "::vm-test::pass"
while :; do :; done
