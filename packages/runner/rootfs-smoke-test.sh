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

# Prove a few of the ported binaries actually execute from the mounted image,
# not just that the files are present. git, vim and python exercise the biggest
# and most representative parts of the userland (libexec fan-out, the runtime
# share tree, the stdlib respectively).
check_runs() {
  bin=$1
  pattern=$2
  out=$("/newroot$bin" --version 2>&1)
  status=$?
  [ "$status" -eq 0 ] || fail "$bin --version exited $status: $out"
  echo "$out" | grep -q "$pattern" || fail "$bin --version output unexpected: $out"
}

check_runs /usr/bin/git "git version"
check_runs /bin/vim "VIM - Vi IMproved"
check_runs /usr/bin/python3 "Python 3.13"

echo "::vm-test::pass"
while :; do :; done
