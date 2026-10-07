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

out=$(btop --version 2>&1) || fail "btop --version failed: $out"
case $out in
*1.4.7*) ;;
*) fail "btop --version: $out" ;;
esac

# Argument parsing reports bad numbers by catching std::stoi's exception.
out=$(btop --update fast 2>&1) && fail "btop accepted a non-numeric update rate"
case $out in
*"Update must be a positive number"*) ;;
*) fail "btop did not catch std::invalid_argument: $out" ;;
esac

# Interactive session on a pty sized above btop's 80x24 minimum: let it draw
# a few frames, then quit with q. BusyBox script exits 0 whatever its child
# does, so the inner shell records btop's own status.
sleep 600 &
mkfifo /tmp/btop-input || fail "creating btop input fifo failed"
script -q -c 'stty rows 40 cols 120; btop --update 200; echo $? >/tmp/btop-status' /dev/null \
  </tmp/btop-input >/tmp/typescript 2>/dev/null &
session_pid=$!
exec 3>/tmp/btop-input || fail "opening btop input fifo failed"

# Ready once a frame lists the sleep, which btop finds by walking /proc.
tries=0
until grep -q sleep /tmp/typescript; do
  tries=$((tries + 1))
  [ "$tries" -le 60 ] || fail "btop did not draw a process list: $(cat /tmp/typescript)"
  sleep 1
done
printf 'q' >&3
exec 3>&-
wait "$session_pid" || fail "script did not exit cleanly: $(cat /tmp/typescript)"
status=$(cat /tmp/btop-status 2>/dev/null)
[ "$status" = 0 ] || fail "btop exited with status '${status}': $(cat /tmp/typescript)"

for title in cpu mem net proc; do
  grep -q "$title" /tmp/typescript || fail "btop did not draw the $title box"
done

echo "::vm-test::pass"
