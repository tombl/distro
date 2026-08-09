#!/bin/busybox sh

PATH=/bin:/sbin:/usr/bin:/usr/sbin

# The server-provided system is a read-only SquashFS. Put a disposable tmpfs
# upper over it so the live session behaves like an ordinary writable machine
# without turning any of its changes into installed state.
mount -t tmpfs tmpfs /run || exec sh
mkdir -p /run/overlay/upper /run/overlay/work /run/overlay/root || exec sh
mount -t overlay overlay \
  -o lowerdir=/,upperdir=/run/overlay/upper,workdir=/run/overlay/work \
  /run/overlay/root || exec sh
mount -t devtmpfs devtmpfs /run/overlay/root/dev || exec sh

# switch_root removes the old root, which cannot work while OverlayFS still
# references it as its lower layer. Keep PID 1 but put it and every child in a
# chroot whose / is the overlay instead.
exec /bin/busybox chroot /run/overlay/root /sbin/site-init
