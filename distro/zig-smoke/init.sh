#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export ZIG_SMOKE=works

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"

zig-smoke alpha beta || fail "zig std smoke exited with $?"

echo "::vm-test::pass"
while :; do :; done
