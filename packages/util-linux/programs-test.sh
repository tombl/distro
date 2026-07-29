#!/bin/sh
# Keep the shipped suite explicit and exercise representative libmount,
# libblkid, and ncurses-backed behavior. The guest contains no BusyBox,
# so a single version check establishes provenance without launching every
# static wasm binary just to repeat identical version plumbing.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

contains() {
  case "$1" in
  *"$2"*) return 0 ;;
  *) return 1 ;;
  esac
}

export PATH=/bin:/sbin:/gnu/bin:/usr/bin:/usr/sbin
export TERM=linux

mount -t devtmpfs devtmpfs /dev || fail "mount devtmpfs"
mount -t proc proc /proc || fail "mount proc"
mount -t sysfs sysfs /sys || fail "mount sysfs"

programs='
addpart agetty bits blkdiscard blkid blkpr blkzone blockdev cal cfdisk
chcpu chmem choom chrt colcrt colrm column copyfilerange coresched
ctrlaltdel delpart dmesg eject exch fadvise fallocate fdisk findfs
findmnt flock fsck.minix fsfreeze fstrim getino getopt hardlink
hexdump hwclock ionice irqtop isosize kill last lastb
lastlog2 ldattach linux32 linux64 logger look losetup lsblk lsclocks lscpu
lsfd lsirq lslocks lslogins lsmem lsns mcookie mesg mkfs mkfs.bfs
mkfs.minix mkswap more mount mountpoint namei nologin nsenter partx pipesz
pivot_root prlimit readprofile rename renice resizepart rev rfkill rtcwake
script scriptlive scriptreplay setarch setpgid setsid setterm sfdisk sulogin
swaplabel swapoff swapon switch_root taskset uclampset ul umount uname26
unshare utmpdump uuidd uuidgen uuidparse waitpid wall wdctl whereis wipefs
zramctl
'

for program in $programs; do
  path=
  for directory in /bin /sbin; do
    [ -x "$directory/$program" ] && path="$directory/$program"
  done
  [ -n "$path" ] || fail "$program is missing"
done

version=$(/bin/mount --version) || fail "mount --version failed"
contains "$version" "util-linux" ||
  fail "suite did not identify as util-linux: $version"

# Direct mount(2), libmount table parsing, and mountpoint all work without the
# unavailable external-helper and parallel-fork modes.
mkdir -p /mnt || fail "create mount point"
mount -t tmpfs tmpfs /mnt || fail "mount tmpfs"
mountpoint -q /mnt || fail "mountpoint did not see /mnt"
fstype=$(findmnt -n -o FSTYPE /mnt)
[ "$fstype" = tmpfs ] || fail "findmnt reported '$fstype' instead of tmpfs"
umount /mnt || fail "umount tmpfs"

# The mmap-free dmesg file-input path parses a saved kernel log.
printf '6,1,1000,-;util-linux dmesg fixture\n' >/tmp/kmsg
dmesg_out=$(dmesg --file /tmp/kmsg)
contains "$dmesg_out" "util-linux dmesg fixture" ||
  fail "dmesg did not parse a saved kmsg file"

# Build and probe a real filesystem image through mkfs.minix and libblkid.
dd if=/dev/zero of=/tmp/minix.img bs=1024 count=256 2>/dev/null ||
  fail "creating minix image"
mkfs.minix /tmp/minix.img >/dev/null || fail "mkfs.minix"
blkid_type=$(blkid -p -s TYPE -o value /tmp/minix.img)
[ "$blkid_type" = minix ] || fail "blkid reported '$blkid_type' instead of minix"
# ncurses is a real dependency now; ul exercises its terminfo-backed formatter.
printf 'X\b_\n' | ul >/tmp/ul.out || fail "ul"
contains "$(cat /tmp/ul.out)" X || fail "ul output: $(od -An -tx1 /tmp/ul.out)"

echo "::vm-test::pass"
while :; do :; done
