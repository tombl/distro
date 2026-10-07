#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export TERM=xterm-256color LANG=C.UTF-8 HOME=/tmp

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /dev/pts || fail "creating /dev/pts failed"
mount -t devpts devpts /dev/pts || fail "mounting devpts failed"
mount -t proc proc /proc || fail "mounting proc failed"
mount -t sysfs sysfs /sys || fail "mounting sysfs failed"

btop --version | grep -q '^btop version: 1\.4\.7' || fail "btop --version: $(btop --version 2>&1)"

# Argument parsing reports bad numbers by catching std::stoi's exception.
out=$(btop --update fast 2>&1) && fail "btop accepted a non-numeric update rate"
case $out in
*"Update must be a positive number"*) ;;
*) fail "btop did not catch std::invalid_argument: $out" ;;
esac

# Interactive session on a pty sized above btop's 80x24 minimum: let it draw
# a few frames, then quit with q.
sleep 600 &
sleeper=$!
mkfifo /tmp/btop-input || fail "creating btop input fifo failed"
script -q -c 'stty rows 40 cols 120; btop --update 200' /dev/null \
  </tmp/btop-input >/tmp/typescript 2>/dev/null &
session_pid=$!
exec 3>/tmp/btop-input || fail "opening btop input fifo failed"

sleep 3
pidof btop >/dev/null || fail "btop did not start under the pty: $(cat /tmp/typescript)"
printf 'q' >&3
exec 3>&-
wait "$session_pid" || fail "btop did not exit cleanly: $(cat /tmp/typescript)"

# Every box title, and a process btop found by walking /proc.
for title in cpu mem net proc; do
  grep -q "$title" /tmp/typescript || fail "btop did not draw the $title box"
done
grep -q "$sleeper" /tmp/typescript || fail "btop did not list the sleep process"

echo "::vm-test::pass"
