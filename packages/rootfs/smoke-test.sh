#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"

i=0
while [ ! -b /dev/vda ]; do
  [ "$i" -lt 100 ] || fail "timed out waiting for /dev/vda"
  i=$((i + 1))
  sleep 0.1
done

mkdir -p /newroot || fail "creating mountpoint failed"
mount -t ext4 /dev/vda /newroot || fail "mounting ext4 rootfs failed"
[ -x /newroot/init ] || fail "rootfs is missing init"
[ -x /newroot/bin/basic-init ] || fail "rootfs is missing basic-init"
[ -x /newroot/bin/busybox ] || fail "rootfs is missing busybox"

echo "::vm-test::pass"
while :; do :; done
