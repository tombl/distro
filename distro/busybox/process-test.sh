#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /dev/pts /etc/network/if-pre-up.d /etc/network/if-up.d \
  /etc/network/if-down.d /etc/network/if-post-down.d /var/run || fail "creating runtime directories failed"
mount -t devpts devpts /dev/pts || fail "mounting devpts failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

# The shell opens fd 9 in the parent. Command substitution enters through
# BusyBox's callback-clone path and execs cat; the child must retain the same
# open-file description and resolve it through the normal Linux /dev/fd link.
printf '%s\n' inherited-fd >/tmp/inherited-fd || fail "creating fd fixture failed"
exec 9</tmp/inherited-fd || fail "opening inherited fd failed"
inherited_fd=$(cat /dev/fd/9) || fail "reading inherited fd in child failed"
exec 9<&-
[ "$inherited_fd" = inherited-fd ] ||
  fail "inherited fd returned [$inherited_fd]"

# hush spawns pipe members and background jobs that only exec an external
# program in a child sharing its memory, so their setup must stay invisible
# to the shell: assignment prefixes, redirects and exec failures.
export SPAWN_OUTER=outer
SPAWN_PREFIX=prefix SPAWN_OUTER=inner SPAWN_OUTER=last env >/tmp/spawn-env &
wait $! || fail "spawning env with assignment prefixes failed"
grep -qx SPAWN_PREFIX=prefix /tmp/spawn-env || fail "assignment prefix missing from spawned env"
[ "$(grep -c '^SPAWN_OUTER=' /tmp/spawn-env)" -eq 1 ] || fail "spawned env repeats an overridden variable"
grep -qx SPAWN_OUTER=last /tmp/spawn-env || fail "spawned env did not take the last assignment"
[ -z "${SPAWN_PREFIX+set}" ] || fail "assignment prefix leaked into the shell"
[ "$SPAWN_OUTER" = outer ] || fail "assignment prefix overwrote [$SPAWN_OUTER]"
# shellcheck disable=SC2034 # must not reach the child's environment
spawn_unexported=1
env | grep -q '^spawn_unexported=' && fail "unexported variable reached a spawned child"
spawn_word=piped
/bin/echo "$spawn_word" 2>/dev/null | /bin/cat | /bin/grep -qx piped ||
  fail "external pipeline with a variable failed"
/bin/cat >/tmp/spawn-stdin &
wait $! || fail "background cat failed"
[ ! -s /tmp/spawn-stdin ] || fail "background job did not read /dev/null"
/bin/echo appended >>/tmp/spawn-redir 2>&1 &
wait $!
grep -qx appended /tmp/spawn-redir || fail "background redirect failed"
/nonexistent/spawn-test 2>/tmp/spawn-missing &
wait $!
spawn_rc=$?
[ "$spawn_rc" -eq 127 ] || fail "missing program exited $spawn_rc instead of 127"
grep -q "can't execute '/nonexistent/spawn-test'" /tmp/spawn-missing ||
  fail "missing program did not report the exec failure"
# shellcheck disable=SC2030,SC2031 # asserting exactly that
/bin/true $((spawn_arith = 5)) | /bin/cat
# shellcheck disable=SC2031
[ -z "$spawn_arith" ] || fail "arithmetic in a pipe member leaked into the shell"
# shellcheck disable=SC2030 # asserting exactly that
/bin/true "${spawn_default:=set}" | /bin/cat
# shellcheck disable=SC2031
[ -z "$spawn_default" ] || fail "default assignment in a pipe member leaked into the shell"
# Opening a FIFO blocks until the other end opens. A background reader whose
# writer is this shell must not suspend the shell until it execs.
mkfifo /tmp/spawn-fifo || fail "creating spawn fifo failed"
/bin/cat </tmp/spawn-fifo >/tmp/spawn-fifo-out &
spawn_reader=$!
exec 8>/tmp/spawn-fifo || fail "opening spawn fifo for writing failed"
echo through-fifo >&8
exec 8>&-
wait "$spawn_reader" || fail "background fifo reader failed"
grep -qx through-fifo /tmp/spawn-fifo-out || fail "background fifo reader lost data"
spawn_i=0
while [ "$spawn_i" -lt 40 ]; do
  /bin/sleep 0 &
  spawn_i=$((spawn_i + 1))
done
wait || fail "waiting for background sleeps failed"

# The forkless timeout watcher sleeps for the requested interval, then signals
# the target. The target is in nanosleep, so cooperative delivery reaches it on
# a kernel entry rather than relying on a pure userspace spin.
timeout_start=$(date +%s) || fail "reading timeout start time failed"
/bin/busybox timeout 1 /bin/busybox sleep 30
timeout_rc=$?
timeout_end=$(date +%s) || fail "reading timeout end time failed"
timeout_elapsed=$((timeout_end - timeout_start))
[ "$timeout_rc" -eq 143 ] || fail "timeout returned $timeout_rc instead of 143"
[ "$timeout_elapsed" -ge 1 ] || fail "timeout fired too early (${timeout_elapsed}s)"
[ "$timeout_elapsed" -le 5 ] || fail "timeout fired too late (${timeout_elapsed}s)"

printf '%s\n' 'root:x:0:0:root:/root:/bin/sh' >/etc/passwd || fail "creating passwd failed"
printf '%s\n' 'root:x:0:' >/etc/group || fail "creating group failed"

script -q -c 'printf "%s\n" script-child' /tmp/typescript </dev/null >/tmp/script-output ||
  fail "script failed"
grep -q script-child /tmp/typescript || fail "script did not record its child output"

start-stop-daemon -S -b -m -p /tmp/test-daemon.pid -x /bin/sleep -- 30 ||
  fail "start-stop-daemon failed to start a process"
read -r daemon_pid </tmp/test-daemon.pid || fail "start-stop-daemon did not create a pidfile"
kill -0 "$daemon_pid" || fail "start-stop-daemon child is not running"
start-stop-daemon -K -p /tmp/test-daemon.pid || fail "start-stop-daemon failed to stop its child"

printf '%s\n' \
  'iface test inet manual' \
  '  up printf "%s\n" up > /tmp/ifup-result' \
  '  down printf "%s\n" down > /tmp/ifdown-result' \
  >/tmp/interfaces || fail "creating interfaces file failed"
ifup -i /tmp/interfaces test || fail "ifup failed"
grep -qx up /tmp/ifup-result || fail "ifup did not run the interface hook"
ifdown -i /tmp/interfaces test || fail "ifdown failed"
grep -qx down /tmp/ifdown-result || fail "ifdown did not run the interface hook"

mkdir -p /tmp/crontabs || fail "creating crontab directory failed"
mkfifo /tmp/cron-ready || fail "creating cron readiness fifo failed"
printf '%s\n' '@reboot printf "%s\n" cron-ran > /tmp/cron-ready' >/tmp/root.crontab ||
  fail "creating crontab failed"
crontab -c /tmp/crontabs /tmp/root.crontab || fail "installing crontab failed"
crontab -c /tmp/crontabs -l | grep -q '^@reboot ' || fail "listing crontab failed"

crond -f -c /tmp/crontabs -L /tmp/crond.log &
crond_pid=$!
read -r cron_result </tmp/cron-ready || fail "reading crond @reboot result failed"
kill "$crond_pid" 2>/dev/null || :
wait "$crond_pid" 2>/dev/null || :
[ "$cron_result" = cron-ran ] || fail "crond @reboot returned [$cron_result]"

crontab -c /tmp/crontabs -r || fail "removing crontab failed"
[ ! -e /tmp/crontabs/root ] || fail "crontab was not removed"

echo "::vm-test::pass"
while :; do :; done
