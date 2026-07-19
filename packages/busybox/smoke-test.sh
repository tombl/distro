#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
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

printf '%s\n' pipeline | grep -qx pipeline || fail "pipeline failed"

substitution=$(printf '%s' command-substitution)
[ "$substitution" = command-substitution ] || fail "command substitution failed"

time -o /tmp/time-output true || fail "time failed to run a command"
grep -q '^real' /tmp/time-output || fail "time did not report resource usage"
time -o /tmp/time-failure sh -c 'exit 7'
status=$?
[ "$status" -eq 7 ] || fail "time returned command exit status $status instead of 7"

printf '%s\n' timestamped | ts -s | grep -Eq '^[0-9][0-9]:[0-9][0-9]:[0-9][0-9] timestamped$' ||
  fail "ts did not timestamp its input"

echo "::vm-test::pass"
while :; do :; done
