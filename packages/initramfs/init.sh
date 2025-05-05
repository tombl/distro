#!/bin/sh

mkdir -p /dev /proc /sys
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev

exec /bin/sh
