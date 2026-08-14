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
