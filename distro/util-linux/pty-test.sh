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
