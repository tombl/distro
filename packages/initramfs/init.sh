#!/bin/busybox sh

PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/busybox mkdir -p /dev /newroot
/bin/busybox mount -t devtmpfs devtmpfs /dev

i=0
while [ ! -b /dev/vda ]; do
  if [ "$i" -ge 100 ]; then
    echo "Timed out waiting for /dev/vda"
    exec /bin/busybox sh
  fi

  i=$((i + 1))
  /bin/busybox sleep 0.1
done

/bin/busybox mount -t ext4 /dev/vda /newroot
/bin/busybox mkdir -p /newroot/dev /newroot/proc /newroot/sys
/bin/busybox mount --move /dev /newroot/dev
/bin/busybox mount -t proc proc /newroot/proc
/bin/busybox mount -t sysfs sysfs /newroot/sys

exec /bin/busybox switch_root /newroot /bin/init
