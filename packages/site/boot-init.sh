#!/bin/busybox sh

PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /dev /newroot
mount -t devtmpfs devtmpfs /dev

i=0
while [ ! -b /dev/vda ]; do
  if [ "$i" -ge 100 ]; then
    echo "site-boot: timed out waiting for /dev/vda"
    exec sh
  fi
  i=$((i + 1))
  sleep 0.1
done

# The site's rootfs is a writable ext4 image (OPFS-persisted in the browser);
# the boot console stays on hvc0 while /dev/vda is the whole disk.
mount -t ext4 -o noatime /dev/vda /newroot || exec sh
mount -t tmpfs tmpfs /newroot/run || exec sh
mount -t tmpfs tmpfs /newroot/tmp || exec sh
mount -t tmpfs tmpfs /newroot/workspace || exec sh
chmod 01777 /newroot/tmp
mount --move /dev /newroot/dev || exec sh
exec /bin/busybox switch_root /newroot /init
