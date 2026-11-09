#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

zig-bootstrap-smoke || fail "zig bootstrap smoke exited with $?"

echo "::vm-test::pass"
while :; do :; done
