#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export TERM=xterm
export TERMINFO=/share/terminfo

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /dev/pts || fail "creating /dev/pts failed"
mount -t devpts devpts /dev/pts || fail "mounting devpts failed"

# script(1) allocates a pty for its child, so readline sees an interactive
# terminal and does line editing. Feed "abcXY", two DELs (0x7f) erasing "YX",
# then "Z": a passthrough read would yield "abcXYZ", the edited buffer "abcZ".
printf 'abcXY\177\177Z\n' | script -q -c readline-echo /dev/null >/tmp/typescript 2>/dev/null ||
  fail "script failed to run readline-echo under a pty"

tr -d '\r' </tmp/typescript >/tmp/clean
grep -q 'READLINE-GOT\[abcZ\]' /tmp/clean ||
  fail "readline did not return the edited line: $(cat /tmp/clean)"

echo "::vm-test::pass"
while :; do :; done
