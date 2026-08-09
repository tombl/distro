#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

rust-smoke one two three || fail "rust-smoke exited with $?"

echo "::vm-test::pass"
while :; do :; done
