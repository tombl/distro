#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mount devtmpfs"
mkdir -p /dev/pts || fail "create /dev/pts"
mount -t devpts devpts /dev/pts || fail "mount devpts"
mount -t proc proc /proc || fail "mount proc"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

script -q -c 'tty && test -t 0 && test -t 1 && test -t 2 && echo SCRIPT_MARKER' \
  -T /tmp/timing /tmp/typescript </dev/null >/tmp/script.out 2>/tmp/script.err
rc=$?
[ "$rc" -eq 0 ] || fail "script command failed (rc=$rc): $(cat /tmp/script.err)"

grep -q '/dev/pts/' /tmp/typescript ||
  fail "typescript does not contain a devpts tty: $(cat /tmp/typescript)"
grep -q 'SCRIPT_MARKER' /tmp/typescript ||
  fail "typescript does not contain marker: $(cat /tmp/typescript)"
grep -q 'SCRIPT_MARKER' /tmp/script.out ||
  fail "script stdout does not contain marker: $(cat /tmp/script.out)"

scriptreplay -T /tmp/timing -O /tmp/typescript >/tmp/replay.out 2>/tmp/replay.err
rc=$?
[ "$rc" -eq 0 ] || fail "scriptreplay failed (rc=$rc): $(cat /tmp/replay.err)"
grep -q 'SCRIPT_MARKER' /tmp/replay.out ||
  fail "scriptreplay output does not contain marker: $(cat /tmp/replay.out)"

echo "script PTY capture and scriptreplay verified"
echo "::vm-test::pass"
while :; do :; done
