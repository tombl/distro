#!/bin/busybox sh

# pid 1 must only rely on busybox applets, invoked explicitly: the rootfs
# ships a full userland that shadows busybox on PATH, and a shadowing package
# may not be init-safe. util-linux's setsid taught us this: it spawns the
# child and exits the parent, which as pid 1 panics the kernel.
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
exec /bin/busybox setsid /bin/busybox cttyhack /bin/busybox sh
