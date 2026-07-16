#!/bin/busybox sh

fail() {
  echo "::tombl-vm-test::fail: $*"
  while :; do :; done
}

word=world
[ "hello $word" = "hello world" ] || fail "shell expansion failed"
[ "$((6 * 7))" -eq 42 ] || fail "shell arithmetic failed"

mkdir -p /tmp/busybox-smoke || fail "mkdir failed"
printf '%s\n' content >/tmp/busybox-smoke/source || fail "printf failed"
cp /tmp/busybox-smoke/source /tmp/busybox-smoke/copy || fail "cp failed"
read -r content </tmp/busybox-smoke/copy || fail "read failed"
[ "$content" = content ] || fail "copied file contained the wrong data"
rm /tmp/busybox-smoke/source /tmp/busybox-smoke/copy || fail "rm failed"
[ ! -e /tmp/busybox-smoke/source ] || fail "rm left its input behind"

echo "::tombl-vm-test::pass"
while :; do :; done
