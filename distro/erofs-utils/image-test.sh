#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
mount -t sysfs sysfs /sys || fail "mounting sysfs failed"

i=0
while [ ! -b /dev/vdb ]; do
  [ "$i" -lt 100 ] || fail "timed out waiting for the image device"
  i=$((i + 1))
  sleep 0.1
done

# A small root: the installed userland plus a few megabytes of compressible
# text, a symlink, a hard link, an empty file, and a nested directory.
mkdir -p /tmp/tree/data/nested || fail "creating the source tree failed"
for directory in bin sbin etc usr lib; do
  [ -d "/$directory" ] && cp -a "/$directory" /tmp/tree/
done
seq 1 500000 >/tmp/tree/data/numbers || fail "generating test data failed"
printf 'hello\n' >/tmp/tree/data/nested/hello || fail "writing a file failed"
: >/tmp/tree/data/empty
ln -s nested/hello /tmp/tree/data/link || fail "creating a symlink failed"
ln /tmp/tree/data/numbers /tmp/tree/data/numbers.hard || fail "creating a hard link failed"
du -sk /tmp/tree

# Centiseconds since boot; busybox date has no subsecond format.
now() {
  read -r uptime _ </proc/uptime
  echo "${uptime%.*}${uptime#*.}"
}

# The flags an image builder uses for a reproducible root.
uuid=01234567-89ab-cdef-0123-456789abcdef
build() {
  mkfs.erofs "$@" -L root --all-root -T0 -U "$uuid" -x-1 "$image" /tmp/tree
}

image=/tmp/root.img
start=$(now)
build || fail "mkfs.erofs failed"
end=$(now)
echo "mkfs.erofs took $((end - start))0 ms"
image=/tmp/again.img
build || fail "rebuilding the image failed"
cmp /tmp/root.img /tmp/again.img || fail "the image is not reproducible"

fsck.erofs /tmp/root.img || fail "fsck.erofs rejected the image"
dump.erofs /tmp/root.img >/tmp/dump || fail "dump.erofs failed"
cat /tmp/dump
grep -q "Filesystem UUID:.*$uuid" /tmp/dump || fail "dump.erofs did not report the UUID"
dump.erofs --path=/data/nested/hello /tmp/root.img || fail "dump.erofs --path failed"
dd if=/tmp/root.img of=/dev/vdb bs=4096 2>/dev/null || fail "writing the image to the device failed"

# The image is accepted by the guest kernel and is usable as a root.
mkdir -p /mnt || fail "creating the mount point failed"
mount -t erofs -o ro /dev/vdb /mnt || fail "the kernel rejected the image"
diff -r /tmp/tree /mnt || fail "the mounted image differs from the source tree"
[ "$(readlink /mnt/data/link)" = nested/hello ] || fail "the symlink target was lost"
[ "$(stat -c %i /mnt/data/numbers)" = "$(stat -c %i /mnt/data/numbers.hard)" ] ||
  fail "the hard link was not preserved"
[ "$(stat -c %u:%g /mnt/data/nested/hello)" = 0:0 ] || fail "--all-root did not apply"
[ "$(chroot /mnt /bin/busybox cat /data/nested/hello)" = hello ] ||
  fail "running a program from the image root failed"
umount /mnt || fail "unmounting the image failed"

# The guest kernel is built without EROFS compression, so compressed images
# are verified in userspace: fsck.erofs decompresses every extent and
# extracts the tree for comparison.
for algorithm in lzma deflate; do
  image="/tmp/$algorithm.img"
  start=$(now)
  build -z"$algorithm" || fail "mkfs.erofs -z$algorithm failed"
  end=$(now)
  echo "mkfs.erofs -z$algorithm took $((end - start))0 ms"
  fsck.erofs --extract="/tmp/$algorithm" "/tmp/$algorithm.img" ||
    fail "fsck.erofs rejected the $algorithm image"
  diff -r /tmp/tree "/tmp/$algorithm" || fail "the $algorithm image differs from the source tree"
  ls -l "/tmp/$algorithm.img"
done

echo "::vm-test::pass"
while :; do :; done
