#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"

# Mounts the next image device, starting at vdb, on /mnt/$1.
device=b
mount_next() {
  i=0
  while [ ! -b "/dev/vd$device" ]; do
    [ "$i" -lt 100 ] || fail "timed out waiting for the $1 image"
    i=$((i + 1))
    sleep 0.1
  done
  mkdir -p "/mnt/$1" || fail "creating the $1 mount point failed"
  mount -t erofs -o ro "/dev/vd$device" "/mnt/$1" ||
    fail "the kernel rejected the $1 image"
  device=$(echo "$device" | tr a-y b-z)
}

mount_next plain

# The images come in the order the check lists them, by increasing physical
# cluster size. Mounting one grows the decompression buffers for good, so each
# is read before a bigger one is mounted.
for image in lz4 lz4hc-tailpacking deflate lzma lz4-pcluster; do
  mount_next "$image"
  # Scattered reads first: they leave compressed data in the cache instead of
  # decompressing it in place, which takes a different path.
  for block in 7 300 1024 1900 2500 3700; do
    for file in numbers zeros; do
      dd if="/mnt/plain/$file" of=/tmp/expected bs=4096 skip="$block" count=1 2>/dev/null
      dd if="/mnt/$image/$file" of=/tmp/actual bs=4096 skip="$block" count=1 2>/dev/null ||
        fail "reading block $block of $file from the $image image failed"
      cmp /tmp/expected /tmp/actual || fail "block $block of $file differs in the $image image"
    done
  done
  diff -r /mnt/plain "/mnt/$image" || fail "the $image image differs from the plain image"
  umount "/mnt/$image" || fail "unmounting the $image image failed"
  echo "$image image matches"
done

echo "::vm-test::pass"
while :; do :; done
