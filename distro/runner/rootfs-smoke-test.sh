#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"

[ -x /bin/basic-init ] || fail "rootfs is missing basic-init"
[ -x /bin/busybox ] || fail "rootfs is missing busybox"
command -v apk >/dev/null || fail "rootfs is missing apk-tools"
busybox true || fail "executing BusyBox failed"
[ ! -e /bin/bash ] || fail "minimal rootfs unexpectedly contains Bash"
[ ! -e /bin/vim ] || fail "minimal rootfs unexpectedly contains Vim"

echo "::vm-test::pass"
while :; do :; done
