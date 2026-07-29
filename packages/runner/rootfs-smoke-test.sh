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
mount -t squashfs -o ro /dev/vda /newroot || fail "mounting squashfs rootfs failed"
[ -x /newroot/init ] || fail "rootfs is missing init"
[ -x /newroot/bin/basic-init ] || fail "rootfs is missing basic-init"
[ -x /newroot/bin/busybox ] || fail "rootfs is missing busybox"
/newroot/bin/busybox true || fail "executing a binary from the mounted rootfs failed"

mount -t tmpfs tmpfs /newroot/tmp || fail "mounting writable tmp"
mount --bind /dev /newroot/dev || fail "mounting dev in rootfs"
# shellcheck disable=SC2016 # $VIMRUNTIME is Vim syntax, not a shell expansion.
TERM=xterm /usr/sbin/chroot /newroot /bin/vim -es \
  -c 'call writefile([$VIMRUNTIME], "/tmp/vimruntime")' \
  -c 'qall!' </dev/null >/newroot/tmp/vim-startup 2>&1 ||
  fail "vim normal startup failed: $(cat /newroot/tmp/vim-startup)"
[ "$(cat /newroot/tmp/vimruntime)" = /usr/share/vim/vim91 ] ||
  fail "vim reports the wrong runtime path: $(cat /newroot/tmp/vimruntime)"

echo "::vm-test::pass"
while :; do :; done
