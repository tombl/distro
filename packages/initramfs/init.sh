#!/bin/busybox sh

/bin/busybox --install -s

mkdir -p /dev /proc /sys
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev

/opt/python/bin/python3 -c 'print(1+1)'
