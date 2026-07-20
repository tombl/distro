#!/bin/busybox sh

# pid 1 must only rely on busybox applets, invoked explicitly: the rootfs
# ships a full userland that shadows busybox on PATH, and a shadowing package
# may not be init-safe. util-linux's setsid taught us this: it spawns the
# child and exits the parent, which as pid 1 panics the kernel.
/bin/busybox mkdir -p /dev/pts
/bin/busybox mount -t devpts devpts /dev/pts
/bin/busybox mount -t proc proc /proc
/bin/busybox ln -snf /proc/self/fd /dev/fd
/bin/busybox ln -snf /proc/self/fd/0 /dev/stdin
/bin/busybox ln -snf /proc/self/fd/1 /dev/stdout
/bin/busybox ln -snf /proc/self/fd/2 /dev/stderr
/bin/busybox mount -t sysfs sysfs /sys
exec /bin/busybox setsid /bin/busybox cttyhack /bin/busybox sh
