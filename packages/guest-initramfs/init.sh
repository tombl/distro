#!/bin/busybox sh

PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /dev /newroot
mount -t devtmpfs devtmpfs /dev

i=0
while [ ! -b /dev/vda ]; do
  if [ "$i" -ge 100 ]; then
    echo "linux-guest: timed out waiting for /dev/vda"
    exec sh
  fi
  i=$((i + 1))
  sleep 0.1
done

mount -t squashfs -o ro /dev/vda /newroot || exec sh
mount -t tmpfs tmpfs /newroot/run || exec sh
mount -t tmpfs tmpfs /newroot/tmp || exec sh
mount -t tmpfs tmpfs /newroot/workspace || exec sh
chmod 01777 /newroot/tmp
mount --move /dev /newroot/dev || exec sh
exec /bin/busybox switch_root /newroot /init
