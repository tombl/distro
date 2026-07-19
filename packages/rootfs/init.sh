#!/bin/busybox sh

mount -t proc proc /proc
mount -t sysfs sysfs /sys
exec setsid cttyhack sh
