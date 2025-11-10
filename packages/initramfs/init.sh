#!/bin/busybox sh

/bin/busybox --install -s

mkdir -p /dev /proc /sys
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev

exec sh
