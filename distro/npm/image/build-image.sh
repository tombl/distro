#!/bin/busybox sh
# Builds a system image onto the machine's only writable virtio block device.
# @lowland/image/build boots the builder image and runs this with arguments it
# has already validated. Host inputs are mounted at the --input directory.
#
#   lowland-build-image --format F --label L --input DIR [--repository URL]
#     [--allow-untrusted] OPERATION...
#
# Packages are installed first, then files and links are applied in order:
#   --package NAME        install NAME from the repository
#   --local PATH          install the .apk at PATH, relative to the input
#   --file DEST SRC MODE  copy SRC, relative to the input, to DEST; MODE - keeps it.
#                         A directory merges into an existing directory DEST.
#   --link DEST TARGET    create a symbolic link at DEST pointing to TARGET
set -e

fail() {
  echo "lowland-build-image: $*" >&2
  exit 1
}

format=
label=
input=
repository=
untrusted=
while [ $# -gt 0 ]; do
  case "$1" in
  --format) format=$2 && shift 2 ;;
  --label) label=$2 && shift 2 ;;
  --input) input=$2 && shift 2 ;;
  --repository) repository=$2 && shift 2 ;;
  --allow-untrusted) untrusted=1 && shift ;;
  *) break ;;
  esac
done
[ -n "$format" ] && [ -n "$label" ] && [ -n "$input" ] || fail "missing build options"

device=
for disk in /sys/block/vd*; do
  [ "$(cat "$disk/ro")" = 0 ] || continue
  [ -z "$device" ] || fail "more than one writable block device"
  device=/dev/${disk##*/}
done
[ -n "$device" ] || fail "no writable block device"

# Each format prepares an empty root directory here and finishes it at the
# end. ext4 is populated in place. EROFS is populated in tmpfs and encoded.
root=/tmp/root
mkdir -p "$root"
case "$format" in
erofs) ;;
ext4)
  mke2fs -q -t ext4 -F -L "$label" -m 0 "$device"
  mount -t ext4 "$device" "$root"
  ;;
*) fail "unsupported format: $format" ;;
esac

# apk verifies the repository with the key installed in the new root.
mkdir -p "$root/etc/apk/keys"
cp /etc/apk/keys/site.rsa.pub "$root/etc/apk/keys/"

# BusyBox hush trips set -e when a while condition ends the loop, so these
# loops end with break instead.
packages() {
  while :; do
    case "$1" in
    '') break ;;
    --package) echo "$2" && shift 2 ;;
    --local) echo "$input/$2" && shift 2 ;;
    --file) shift 4 ;;
    --link) shift 3 ;;
    *) fail "unknown operation: $1" ;;
    esac
  done
}

contents() {
  while :; do
    case "$1" in
    '') break ;;
    --package | --local) shift 2 ;;
    --file)
      mkdir -p "$(dirname "$root$2")"
      # A directory onto an existing directory merges into it. cp -a would
      # otherwise nest it under its staged name.
      if [ -d "$input/$3" ] && [ -d "$root$2" ]; then
        cp -a "$input/$3/." "$root$2"
      else
        cp -a "$input/$3" "$root$2"
      fi
      chown -R 0:0 "$root$2"
      [ "$4" = - ] || chmod "$4" "$root$2"
      shift 4
      ;;
    --link)
      mkdir -p "$(dirname "$root$2")"
      ln -s "$3" "$root$2"
      shift 3
      ;;
    esac
  done
}

# Package names and staged input paths never contain whitespace.
# shellcheck disable=SC2046
apk \
  --root "$root" \
  --arch wasm32 \
  --no-cache \
  ${untrusted:+--allow-untrusted} \
  ${repository:+--repository "$repository"} \
  add --initdb $(packages "$@")
# The log records the build command and a timestamp, like apk.mkSystem drops.
rm -f "$root/var/log/apk.log"

# Like the canonical image, the result installs from the public repository.
# This is written after the install so offline builds never consult it.
echo http://assets.low.land/apk/wasm32/Packages.adb >"$root/etc/apk/repositories"
cp /etc/resolv.conf "$root/etc/resolv.conf"

contents "$@"

# The standard FHS directories, as mkImage creates them.
mkdir -p "$root/dev" "$root/mnt" "$root/proc" "$root/root" "$root/run" "$root/sys" "$root/tmp"
chmod 01777 "$root/tmp"

case "$format" in
erofs)
  # Like mkImage, but uncompressed because the kernel lacks
  # EROFS compression. Writing to a block device prints a harmless warning
  # that it cannot be erased.
  mkfs.erofs --quiet --all-root --all-time -T 0 \
    -U 00000000-0000-0000-0000-000000000000 -L "$label" -x-1 "$device" "$root"
  ;;
ext4) umount "$root" ;;
esac
sync
