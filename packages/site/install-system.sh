#!/bin/busybox sh
set -e

target=/mnt
origin=$(cat /run/site-origin)
repository="$origin/install-repo/wasm32/Packages.adb"

mkdir -p "$target"
mount -t ext4 /dev/vdb "$target"
mkdir -p "$target/boot" "$target/dev" "$target/proc" "$target/run" "$target/sys"
mount --bind /boot "$target/boot"

cleanup() {
  umount "$target/boot" 2>/dev/null || true
  umount "$target" 2>/dev/null || true
}
trap cleanup EXIT

apk \
  --root "$target" \
  --arch wasm32 \
  --allow-untrusted \
  --repository "$repository" \
  add --initdb \
  apk-tools \
  busybox \
  linux-guest-agent \
  lowland-boot

cp /sbin/site-init "$target/init"
mkdir -p "$target/etc/apk/keys"
cp /etc/apk/keys/site.rsa.pub "$target/etc/apk/keys/site.rsa.pub"
cp /etc/apk/repositories "$target/etc/apk/repositories"
sync
cleanup
trap - EXIT

printf '\nInstallation complete. Reload the page to boot from /root.ext4.\n'
