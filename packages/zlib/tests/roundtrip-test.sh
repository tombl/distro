#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

output=$(/bin/roundtrip) || fail "round trip program exited nonzero"
echo "$output" | grep -q '^zlib-roundtrip-ok version 1.3.1' ||
  fail "unexpected output: $output"

echo "::vm-test::pass"
while :; do :; done
