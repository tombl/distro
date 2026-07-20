#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

seq 1 4000 >/tmp/data || fail "generating test data failed"

bzip2 -c /tmp/data >/tmp/data.bz2 || fail "compression failed"
bzip2 -d -c /tmp/data.bz2 >/tmp/data.out || fail "decompression failed"
cmp /tmp/data /tmp/data.out || fail "round-tripped data did not match the original"

# A truncated stream must be rejected with a nonzero exit.
head -c 32 /tmp/data.bz2 >/tmp/data.bad || fail "truncating the stream failed"
if bzip2 -d -c /tmp/data.bad >/dev/null 2>&1; then
  fail "decompressing a corrupted stream succeeded"
fi

echo "::vm-test::pass"
while :; do :; done
