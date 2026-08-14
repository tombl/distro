#!/bin/sh
# Keep the shipped suite explicit and exercise representative libmount,
# libblkid, and ncurses-backed behavior. A version check establishes that
# util-linux owns its overlapping paths rather than BusyBox.

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

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
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

# Mount namespaces remain available even though optional namespace families
# are disabled in the kernel configuration.  A mount made by unshare must not
# escape, and nsenter must observe a mount held by another process.
mkdir -p /tmp/ns-direct /tmp/ns-held
unshare -m sh -c 'mount -t tmpfs tmpfs /tmp/ns-direct && mountpoint -q /tmp/ns-direct' ||
  fail "direct mount namespace"
mountpoint -q /tmp/ns-direct && fail "unshared mount escaped into parent"

setsid --fork unshare -m sh -c \
  'mount -t tmpfs tmpfs /tmp/ns-held || exit; echo $$ >/tmp/ns.pid; sleep 20'
i=0
while [ ! -s /tmp/ns.pid ] && [ "$i" -lt 50 ]; do
  sleep 1
  i=$((i + 1))
done
[ -s /tmp/ns.pid ] || fail "held namespace did not start"
ns_pid=$(cat /tmp/ns.pid)
nsenter -t "$ns_pid" -m mountpoint -q /tmp/ns-held ||
  fail "nsenter did not observe target mount namespace"
mountpoint -q /tmp/ns-held && fail "held mount escaped into parent"
kill "$ns_pid" 2>/dev/null || true

# The mmap-free dmesg file-input path parses a saved kernel log.
printf '6,1,1000,-;util-linux dmesg fixture\n' >/tmp/kmsg
dmesg_out=$(dmesg --file /tmp/kmsg)
contains "$dmesg_out" "util-linux dmesg fixture" ||
  fail "dmesg did not parse a saved kmsg file"

# pager_preexec must affect only the callback child.  The fake pager records
# its defaults and stdin; test_pager itself checks its environment after close.
cat >/tmp/test-pager-child <<'EOF'
#!/bin/sh
printf 'LESS=%s\nLV=%s\n' "$LESS" "$LV" >/tmp/pager-child.env
cat >/tmp/pager.stdin
EOF
chmod +x /tmp/test-pager-child
unset LESS LV
PAGER=/tmp/test-pager-child /test_pager || fail "test_pager"
[ "$(cat /tmp/pager-child.env)" = "LESS=FRSX
LV=-c" ] || fail "pager child defaults: $(cat /tmp/pager-child.env)"
contains "$(cat /tmp/pager.stdin)" "254" || fail "pager did not receive stdin"

# The restricted-path callback child assumes the real identity while its
# privileged parent keeps euid 0.  Check both result and signed errno paths.
mkdir -p /tmp/restricted-root
printf 'world\n' >/tmp/restricted-world
printf 'root\n' >/tmp/restricted-root/file
chmod 644 /tmp/restricted-world
chmod 700 /tmp/restricted-root
restricted_ok=$(/test_fileutils --restricted-path 1000 /tmp/restricted-world) ||
  fail "restricted-path success probe"
[ "$restricted_ok" = \
  "parent=1000:0 access=0 errno=0 result=1000:1000:/tmp/restricted-world" ] ||
  fail "restricted-path success semantics: $restricted_ok"
restricted_denied=$(/test_fileutils --restricted-path 1000 /tmp/restricted-root/file) ||
  fail "restricted-path errno probe"
[ "$restricted_denied" = "parent=1000:0 access=0 errno=13 result=(null)" ] ||
  fail "restricted-path errno semantics: $restricted_denied"

# Build and probe a real filesystem image through mkfs.minix and libblkid.
dd if=/dev/zero of=/tmp/minix.img bs=1024 count=256 2>/dev/null ||
  fail "creating minix image"
mkfs.minix /tmp/minix.img >/dev/null || fail "mkfs.minix"
blkid_type=$(blkid -p -s TYPE -o value /tmp/minix.img)
[ "$blkid_type" = minix ] || fail "blkid reported '$blkid_type' instead of minix"
# ncurses is a real dependency now; ul exercises its terminfo-backed formatter.
printf 'X\b_\n' | ul >/tmp/ul.out || fail "ul"
contains "$(cat /tmp/ul.out)" X || fail "ul output: $(od -An -tx1 /tmp/ul.out)"

# Compressed maps use zcat through posix_spawn.  The synthetic profile has a
# 16-byte sampling step and one sample attributed to fixture_symbol.
cat >/tmp/System.map <<'EOF'
00000010 T _stext
00000020 T fixture_symbol
00000030 T _etext
EOF
gzip -c /tmp/System.map >/tmp/System.map.gz || fail "compress System.map"
printf '\020\000\000\000\007\000\000\000' >/tmp/profile
readprofile -m /tmp/System.map.gz -p /tmp/profile >/tmp/readprofile.out ||
  fail "readprofile compressed map"
contains "$(cat /tmp/readprofile.out)" "fixture_symbol" ||
  fail "readprofile did not parse compressed map: $(cat /tmp/readprofile.out)"

# Closing descriptors 0 and 1 makes pipe() allocate stdout as its write end.
# The spawn actions must leave that already-correct descriptor open for zcat.
sh -c 'exec 0<&- 1>&-; readprofile -m /tmp/System.map.gz -p /tmp/profile' \
  2>/tmp/readprofile-lowfd.err
lowfd_rc=$?
[ "$lowfd_rc" -eq 1 ] ||
  fail "readprofile low-fd exited $lowfd_rc: $(cat /tmp/readprofile-lowfd.err)"
[ "$(cat /tmp/readprofile-lowfd.err)" = "readprofile: write error" ] ||
  fail "readprofile low-fd failed before final output: $(cat /tmp/readprofile-lowfd.err)"

echo "::vm-test::pass"
while :; do :; done
