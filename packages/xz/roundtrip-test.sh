#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

seq 1 4000 >/tmp/data || fail "generating test data failed"

xz -k -c /tmp/data >/tmp/data.xz || fail "compression failed"
xz -d -c /tmp/data.xz >/tmp/data.out || fail "decompression failed"
cmp /tmp/data /tmp/data.out || fail "round-tripped data did not match the original"

# A truncated stream must be rejected with a nonzero exit.
head -c 64 /tmp/data.xz >/tmp/data.bad || fail "truncating the stream failed"
if xz -d -c /tmp/data.bad >/dev/null 2>&1; then
  fail "decompressing a corrupted stream succeeded"
fi

echo "::vm-test::pass"
while :; do :; done
