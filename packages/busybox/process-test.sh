#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /dev/pts /etc/network/if-pre-up.d /etc/network/if-up.d \
  /etc/network/if-down.d /etc/network/if-post-down.d /var/run || fail "creating runtime directories failed"
mount -t devpts devpts /dev/pts || fail "mounting devpts failed"
mount -t proc proc /proc || fail "mounting proc failed"

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
printf '%s\n' '@reboot printf "%s\n" cron-ran > /tmp/cron-result' >/tmp/root.crontab ||
  fail "creating crontab failed"
crontab -c /tmp/crontabs /tmp/root.crontab || fail "installing crontab failed"
crontab -c /tmp/crontabs -l | grep -q '^@reboot ' || fail "listing crontab failed"

crond -f -c /tmp/crontabs -L /tmp/crond.log &
crond_pid=$!
tries=0
while [ ! -e /tmp/cron-result ] && [ "$tries" -lt 50 ]; do
  sleep 0.02
  tries=$((tries + 1))
done
kill "$crond_pid" 2>/dev/null || :
wait "$crond_pid" 2>/dev/null || :
grep -qx cron-ran /tmp/cron-result || fail "crond did not run an @reboot job"

crontab -c /tmp/crontabs -r || fail "removing crontab failed"
[ ! -e /tmp/crontabs/root ] || fail "crontab was not removed"

echo "::vm-test::pass"
while :; do :; done
