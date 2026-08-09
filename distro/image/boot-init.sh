#!/bin/busybox sh

PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /dev /newroot
mount -t devtmpfs devtmpfs /dev

i=0
while [ ! -b /dev/vda ]; do
  if [ "$i" -ge 100 ]; then
    echo "boot-initramfs: timed out waiting for /dev/vda"
    exec sh
  fi
  i=$((i + 1))
  sleep 0.1
done

immutable=1
if ! mount -t squashfs -o ro /dev/vda /newroot 2>/dev/null; then
  immutable=0
  mount -t ext4 -o rw /dev/vda /newroot || exec sh
fi

# Immutable images get volatile working directories. An ext4 root deliberately
# keeps them on disk so callers can use the whole filesystem as persistent,
# mutable state.
if [ "$immutable" -eq 1 ]; then
  mount -t tmpfs tmpfs /newroot/run || exec sh
  mount -t tmpfs tmpfs /newroot/tmp || exec sh
  mount -t tmpfs tmpfs /newroot/workspace || exec sh
fi
chmod 01777 /newroot/tmp
mount --move /dev /newroot/dev || exec sh
exec /bin/busybox switch_root /newroot /init
