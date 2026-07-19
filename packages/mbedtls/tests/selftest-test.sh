#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

# The DRBG stage seeds from getrandom()/`/dev/urandom`, so give mbedtls a real
# device tree to read from.
mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"

output=$(/bin/selftest) || fail "selftest exited nonzero: $output"

echo "$output" | grep -q '^sha256 ok$' || fail "sha256 stage: $output"
echo "$output" | grep -q '^aes ok$' || fail "aes stage: $output"
echo "$output" | grep -q '^entropy ok$' || fail "entropy stage: $output"
echo "$output" | grep -q '^all-ok$' || fail "did not reach all-ok: $output"

echo "::vm-test::pass"
while :; do :; done
