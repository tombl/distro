#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

output=$(/bin/roundtrip) || fail "round trip program exited nonzero"
echo "$output" | grep -q '^zlib-roundtrip-ok version 1.3.1' ||
  fail "unexpected output: $output"

echo "::vm-test::pass"
while :; do :; done
