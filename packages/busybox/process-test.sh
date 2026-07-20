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
