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
mount -t squashfs -o ro /dev/vda /newroot || fail "mounting site rootfs failed"
mount -t tmpfs tmpfs /newroot/tmp || fail "mounting writable tmp"
mount --bind /dev /newroot/dev || fail "mounting dev in rootfs"

check_runs() {
  command=$1
  shift
  /usr/sbin/chroot /newroot "/bin/$command" "$@" >/dev/null 2>&1 || fail "$command failed"
}

check_runs sqlite3 --version
check_runs jq --version
check_runs git --version
check_runs vim --version
check_runs less --version
check_runs curl --version

[ -x /newroot/libexec/git-core/git-remote-http ] || fail "git HTTP transport is missing"
[ -L /newroot/libexec/git-core/git-remote-https ] || fail "git HTTPS transport is missing"
/usr/sbin/chroot /newroot /bin/git init /tmp/repository >/dev/null 2>&1 || fail "git init failed"

echo "::vm-test::pass"
while :; do :; done
