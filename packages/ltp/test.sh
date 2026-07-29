#!/bin/busybox sh

# Run one curated LTP suite. Each line in /ltp-tests is a binary name; suite
# membership lives in package.nix so the build, guest contents, and check cannot
# drift apart. A maintained test must produce real coverage: TCONF-only results
# are failures here, not silently accepted skips.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export TMPDIR=/tmp
export LTP_COLORIZE_OUTPUT=n
export LTP_VIRT_OVERRIDE=wasm

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
mount -t sysfs sysfs /sys || fail "mounting sysfs failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

if [ -e /ltp-device ]; then
  i=0
  while [ ! -b /dev/vda ]; do
    [ "$i" -lt 100 ] || fail "timed out waiting for LTP test device"
    i=$((i + 1))
    sleep 0.1
  done
  export LTP_DEV=/dev/vda
  export LTP_DEV_FS_TYPE=ext2
fi

failed=0
while read -r test; do
  [ -n "$test" ] || continue

  printf '=== %s (started) ===\n' "$test"
  out=$(cd /tmp && timeout 15 "/bin/$test" 2>&1)
  rc=$?
  printf '=== %s (exit %d) ===\n%s\n' "$test" "$rc" "$out"

  if [ "$rc" -eq 124 ]; then
    printf 'vm test guest failure: %s timed out\n' "$test"
    failed=1
  elif [ "$rc" -ne 0 ]; then
    printf 'vm test guest failure: %s failed with exit status %d\n' "$test" "$rc"
    echo "$out" | grep -E 'TFAIL|TBROK|TCONF' | while read -r detail; do
      printf 'vm test guest failure: %s: %s\n' "$test" "$detail"
    done
    failed=1
  elif ! echo "$out" | grep -q 'TPASS'; then
    printf 'vm test guest failure: %s reported no TPASS\n' "$test"
    failed=1
  fi
done </ltp-tests

[ "$failed" -eq 0 ] || fail "one or more LTP tests failed"
echo "::vm-test::pass"
while :; do :; done
