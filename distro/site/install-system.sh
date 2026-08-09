#!/bin/busybox sh
set -e

target=/mnt
repository=http://assets.low.land/apk/wasm32/Packages.adb

mkdir -p "$target"
mount -t ext4 LABEL=LOWLAND_INSTALL "$target"
mkdir -p \
  "$target/boot" \
  "$target/dev" \
  "$target/mnt" \
  "$target/proc" \
  "$target/run" \
  "$target/sys" \
  "$target/tmp"
chmod 1777 "$target/tmp"
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
  lowland-boot

cp /sbin/site-init "$target/init"
mkdir -p "$target/etc/apk/keys"
cp /etc/apk/keys/site.rsa.pub "$target/etc/apk/keys/site.rsa.pub"
cp /etc/apk/repositories "$target/etc/apk/repositories"
cp /etc/resolv.conf "$target/etc/resolv.conf"
touch "$target/etc/lowland-installed"
sync
cleanup
trap - EXIT

printf '\nInstallation complete. Reload the page to boot the installed system.\n'
