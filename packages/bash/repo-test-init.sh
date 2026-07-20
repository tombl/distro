#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"

# This is intentionally invoked as an argument to Bash: the existing script's
# BusyBox shebang is then only a comment, proving its portable body under Bash.
exec bash /repo-tests/bzip2-roundtrip-test.sh
