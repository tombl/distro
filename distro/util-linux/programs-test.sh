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
ctrlaltdel delpart dmesg exch fallocate fdisk fincore findfs
findmnt flock fsck fsck.cramfs fsck.minix fsfreeze fstrim getino getopt hardlink
hexdump hwclock ionice irqtop isosize kill last lastb
lastlog2 linux32 linux64 logger look losetup lsblk lsclocks lscpu
lsfd lsirq lslocks lslogins lsmem lsns mcookie mesg mkfs mkfs.bfs
mkfs.cramfs mkfs.minix mkswap more mount mountpoint namei nologin nsenter partx pipesz
pivot_root prlimit readprofile rename renice resizepart rev rfkill rtcwake
script scriptlive scriptreplay setarch setpgid setsid setterm sfdisk sulogin
swaplabel switch_root taskset uclampset ul umount uname26
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

for program in swapon swapoff eject fadvise ldattach; do
  [ ! -e "/bin/$program" ] && [ ! -e "/sbin/$program" ] ||
    fail "$program should be disabled for the target kernel/device configuration"
done

# Formatting swap images remains useful offline even though this kernel cannot
# activate them.  Keep mkswap and verify the resulting image format.
dd if=/dev/zero of=/tmp/swap.img bs=1024 count=1024 2>/dev/null ||
  fail "creating swap image"
mkswap -L WASM-SWAP /tmp/swap.img >/dev/null || fail "mkswap image"
contains "$(file /tmp/swap.img)" "Linux swap file" ||
  fail "mkswap did not create a swap image"

version=$(/bin/mount --version) || fail "mount --version failed"
contains "$version" "util-linux" ||
  fail "suite did not identify as util-linux: $version"

# Direct mount(2), libmount table parsing, and mountpoint work normally.
mkdir -p /mnt || fail "create mount point"
mount -t tmpfs tmpfs /mnt || fail "mount tmpfs"
mountpoint -q /mnt || fail "mountpoint did not see /mnt"
fstype=$(findmnt -n -o FSTYPE /mnt)
[ "$fstype" = tmpfs ] || fail "findmnt reported '$fstype' instead of tmpfs"
umount /mnt || fail "umount tmpfs"

# External helpers run in copy-clone children.  Record every argument and the
# post-drop real/effective credentials, and ensure the helper's exact status is
# returned without mutating the calling shell's credentials.
cat >/sbin/mount.test <<'EOF'
#!/bin/sh
{
  printf 'uid=%s euid=%s\n' "$(id -ru)" "$(id -u)"
  for arg do printf 'arg=%s\n' "$arg"; done
} >"${MOUNT_HELPER_LOG:-/tmp/mount-helper.log}"

if [ "$MOUNT_HELPER_MODE" = parallel ]; then
  name=${2##*/}
  touch "/tmp/mount-helper-ready-$name"
  i=0
  while [ ! -e /tmp/mount-helper-ready-mnt-a ] && [ "$i" -lt 100 ]; do
    sleep .05
    i=$((i + 1))
  done
  i=0
  while [ ! -e /tmp/mount-helper-ready-mnt-b ] && [ "$i" -lt 100 ]; do
    sleep .05
    i=$((i + 1))
  done
  [ -e /tmp/mount-helper-ready-mnt-a ] &&
    [ -e /tmp/mount-helper-ready-mnt-b ] || exit 70
  echo "$name" >>/tmp/mount-helper-overlap
  if [ "$MOUNT_HELPER_FAIL" = "$name" ] || [ "$MOUNT_HELPER_FAIL" = all ]; then
    echo "$name" >/tmp/mount-helper-failed
    exit 1
  fi
  exit 0
fi

exit "${MOUNT_HELPER_STATUS:-0}"
EOF
chmod +x /sbin/mount.test

cat >/tmp/mount.credential <<'EOF'
#!/bin/sh
printf 'uid=%s euid=%s\n' "$(id -ru)" "$(id -u)" >/tmp/mount-credential.log
EOF
chmod +x /tmp/mount.credential
/test_mount_context_mount --helper-credentials /tmp/mount.credential \
  >/tmp/mount-credential-parent || fail "mount helper credential isolation"
[ "$(cat /tmp/mount-credential.log)" = 'uid=1000 euid=1000' ] ||
  fail "mount helper did not drop credentials: $(cat /tmp/mount-credential.log)"
[ "$(cat /tmp/mount-credential-parent)" = 'parent uid=1000 euid=0' ] ||
  fail "mount helper mutated parent credentials: $(cat /tmp/mount-credential-parent)"

rm -f /tmp/mount-helper.log
MOUNT_HELPER_STATUS=23 MOUNT_HELPER_LOG=/tmp/mount-helper.log \
  mount -t test -s -f -n -v -o foo=bar helper-source /tmp/helper-target
mount_rc=$?
[ "$mount_rc" -eq 23 ] || fail "mount helper status $mount_rc"
[ "$(id -u)" -eq 0 ] || fail "mount helper changed parent credentials"
contains "$(cat /tmp/mount-helper.log)" 'uid=0 euid=0' ||
  fail "mount helper credentials: $(cat /tmp/mount-helper.log)"
mount_helper_log=$(cat /tmp/mount-helper.log)
[ "$mount_helper_log" = "uid=0 euid=0
arg=helper-source
arg=/tmp/helper-target
arg=-s
arg=-f
arg=-n
arg=-v
arg=-o
arg=rw,foo=bar" ] || fail "mount helper argv: $mount_helper_log"

# umount helpers preserve their option order/status too.  Keep a real tmpfs
# mounted so libmount selects umount.tmpfs, then clean it up internally.
cat >/sbin/umount.tmpfs <<'EOF'
#!/bin/sh
{
  printf 'uid=%s euid=%s\n' "$(id -ru)" "$(id -u)"
  for arg do printf 'arg=%s\n' "$arg"; done
} >/tmp/umount-helper.log
exit 24
EOF
chmod +x /sbin/umount.tmpfs
mkdir -p /tmp/umount-helper-target
mount -i -t tmpfs tmpfs /tmp/umount-helper-target || fail "helper fixture mount"
umount -n -l -f -v -r /tmp/umount-helper-target
umount_rc=$?
[ "$umount_rc" -eq 24 ] || fail "umount helper status $umount_rc"
umount_helper_log=$(cat /tmp/umount-helper.log)
[ "$umount_helper_log" = "uid=0 euid=0
arg=/tmp/umount-helper-target
arg=-n
arg=-l
arg=-f
arg=-v
arg=-r" ] || fail "umount helper argv: $umount_helper_log"
mountpoint -q /tmp/umount-helper-target || fail "umount helper unexpectedly unmounted"
umount -i /tmp/umount-helper-target || fail "helper fixture cleanup"

# -F must launch both rows before either helper can leave its barrier.  The
# existing child list then reaps both and computes all-success versus SOMEOK.
mkdir -p /tmp/mnt-a /tmp/mnt-b
cat >/tmp/libmount-fstab <<'EOF'
helper-a /tmp/mnt-a test defaults 0 0
helper-b /tmp/mnt-b test defaults 0 0
EOF
rm -f /tmp/mount-helper-ready-* /tmp/mount-helper-overlap /tmp/mount-helper-failed
MOUNT_HELPER_MODE=parallel mount -a -F -T /tmp/libmount-fstab ||
  fail "parallel mount helpers"
[ "$(sort /tmp/mount-helper-overlap)" = "mnt-a
mnt-b" ] || fail "mount -F helpers did not overlap"
rm -f /tmp/mount-helper-ready-* /tmp/mount-helper-overlap
MOUNT_HELPER_MODE=parallel MOUNT_HELPER_FAIL=mnt-b \
  mount -a -F -T /tmp/libmount-fstab
mount_rc=$?
[ "$(cat /tmp/mount-helper-failed)" = mnt-b ] ||
  fail "mixed mount helper did not return failure"
[ "$mount_rc" -eq 64 ] || fail "mount -F mixed status $mount_rc"
[ "$(sort /tmp/mount-helper-overlap)" = "mnt-a
mnt-b" ] || fail "mixed mount -F helpers did not overlap"
rm -f /tmp/mount-helper-ready-* /tmp/mount-helper-overlap
MOUNT_HELPER_MODE=parallel MOUNT_HELPER_FAIL=all \
  mount -a -F -T /tmp/libmount-fstab
mount_rc=$?
[ "$mount_rc" -eq 32 ] || fail "mount -F all-failed status $mount_rc"

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

# Supervised mount-namespace children preserve exit status and isolate mounts.
mkdir -p /tmp/ns-fork
echo "unshare phase: fork"
unshare -m --fork sh -c \
  'mount -t tmpfs tmpfs /tmp/ns-fork || exit 90; exit 23'
unshare_rc=$?
[ "$unshare_rc" -eq 23 ] || fail "unshare --fork status $unshare_rc"
mountpoint -q /tmp/ns-fork && fail "forked unshare mount escaped"

# Signal forwarding reaches the supervised child and returns its exact status.
echo "unshare phase: forward"
for unshare_run in 1 2 3; do
  rm -f "/tmp/unshare-forward.signal-$unshare_run"
  UNSHARE_RUN=$unshare_run timeout 10 unshare -m --forward-signals sh -c \
    'trap "echo TERM >\"/tmp/unshare-forward.signal-$UNSHARE_RUN\"; exit 42" TERM; kill -TERM "$PPID"; while :; do sleep .1; done'
  unshare_rc=$?
  [ "$unshare_rc" -eq 42 ] || fail "forward-signals run $unshare_run status $unshare_rc"
  [ "$(cat "/tmp/unshare-forward.signal-$unshare_run")" = TERM ] ||
    fail "forwarded TERM missing run $unshare_run"
done

# --kill-child installs the requested parent-death signal in the callback child.
rm -f /tmp/unshare-kill.ready /tmp/unshare-kill.signal
echo "unshare phase: kill-child"
unshare -m --kill-child=TERM sh -c \
  'trap "echo TERM >/tmp/unshare-kill.signal; exit" TERM; echo ready >/tmp/unshare-kill.ready; while :; do sleep .1; done' &
unshare_parent=$!
i=0
while [ ! -s /tmp/unshare-kill.ready ] && [ "$i" -lt 100 ]; do
  sleep .05
  i=$((i + 1))
done
[ -s /tmp/unshare-kill.ready ] || fail "kill-child readiness"
kill -KILL "$unshare_parent" || fail "kill unshare supervisor"
wait "$unshare_parent" 2>/dev/null
i=0
while [ ! -s /tmp/unshare-kill.signal ] && [ "$i" -lt 100 ]; do
  sleep .05
  i=$((i + 1))
done
[ "$(cat /tmp/unshare-kill.signal)" = TERM ] || fail "kill-child signal missing"

# The pre-unshare helper pins the new mount namespace from its original one.
mkdir -p /tmp/ns-persist-view
: >/tmp/ns-persist
echo "unshare phase: persistence"
timeout 10 unshare --mount=/tmp/ns-persist --fork sh -c \
  'mount -t tmpfs tmpfs /tmp/ns-persist-view && touch /tmp/ns-persist-view/inside' ||
  fail "persist mount namespace"
nsenter --mount=/tmp/ns-persist test -e /tmp/ns-persist-view/inside ||
  fail "nsenter persisted mount namespace"
[ ! -e /tmp/ns-persist-view/inside ] || fail "persisted mount escaped"
umount /tmp/ns-persist || fail "unmount persisted namespace"

# Generic fsck keeps checker process status, parallel/serialized scheduling,
# stdin handling, wait4 statistics, signal delivery, and progress handoff.
touch /tmp/fsck-dev1 /tmp/fsck-dev2
cat >/tmp/fsck.test <<'EOF'
#!/bin/sh
dev=
for arg do dev=$arg; done
name=${dev##*/}
case "$FSCK_TEST_MODE" in
status) exit 4 ;;
parallel)
  touch "/tmp/fsck-start-$name"
  other=fsck-dev1; [ "$name" = fsck-dev1 ] && other=fsck-dev2
  i=0
  while [ ! -e "/tmp/fsck-start-$other" ] && [ "$i" -lt 100 ]; do sleep .05; i=$((i + 1)); done
  [ -e "/tmp/fsck-start-$other" ] || exit 8
  ;;
serial)
  [ ! -e /tmp/fsck-active ] || echo overlap >/tmp/fsck-overlap
  touch /tmp/fsck-active
  sleep .2
  rm -f /tmp/fsck-active
  echo "$name" >>/tmp/fsck-serial
  ;;
stdin)
  if read line; then echo open >/tmp/fsck-stdin; else echo closed >>/tmp/fsck-stdin; fi
  ;;
stdin-one)
  if read line && [ "$line" = preserved ]; then echo preserved >/tmp/fsck-stdin-one; else exit 8; fi
  ;;
signal)
  trap 'echo TERM >/tmp/fsck-signal; exit 0' TERM
  echo ready >/tmp/fsck-signal-ready
  while :; do sleep .1; done
  ;;
esac
exit 0
EOF
chmod +x /tmp/fsck.test
PATH=/tmp:$PATH FSCK_TEST_MODE=status fsck -T -t test /tmp/fsck-dev1
fsck_rc=$?
[ "$fsck_rc" -eq 4 ] || fail "fsck checker status $fsck_rc"
PATH=/tmp:$PATH FSCK_TEST_MODE=status fsck -T -r -t test /tmp/fsck-dev1 >/tmp/fsck-stats
contains "$(cat /tmp/fsck-stats)" "/tmp/fsck-dev1: status 4, rss " ||
  fail "fsck wait4 statistics: $(cat /tmp/fsck-stats)"
rm -f /tmp/fsck-start-*
echo "fsck phase: parallel"
PATH=/tmp:$PATH FSCK_FORCE_ALL_PARALLEL=1 FSCK_TEST_MODE=parallel \
  fsck -T -t test /tmp/fsck-dev1 /tmp/fsck-dev2 || fail "parallel fsck"
rm -f /tmp/fsck-active /tmp/fsck-overlap /tmp/fsck-serial
echo "fsck phase: serial"
PATH=/tmp:$PATH FSCK_FORCE_ALL_PARALLEL=1 FSCK_TEST_MODE=serial \
  fsck -T -s -t test /tmp/fsck-dev1 /tmp/fsck-dev2 || fail "serialized fsck"
[ ! -e /tmp/fsck-overlap ] && [ "$(wc -l </tmp/fsck-serial)" -eq 2 ] ||
  fail "fsck -s scheduling"
rm -f /tmp/fsck-stdin
echo "fsck phase: stdin"
printf 'must-not-be-read\n' | PATH=/tmp:$PATH FSCK_FORCE_ALL_PARALLEL=1 \
  FSCK_TEST_MODE=stdin fsck -T -t test /tmp/fsck-dev1 /tmp/fsck-dev2 ||
  fail "fsck stdin handling"
[ "$(cat /tmp/fsck-stdin)" = "closed
closed" ] || fail "noninteractive checker stdin was not closed"
rm -f /tmp/fsck-stdin-one
printf 'preserved\n' | PATH=/tmp:$PATH FSCK_TEST_MODE=stdin-one \
  fsck -T -t test /tmp/fsck-dev1 || fail "interactive fsck stdin"
[ "$(cat /tmp/fsck-stdin-one)" = preserved ] ||
  fail "single checker stdin was not preserved"
rm -f /tmp/fsck-signal /tmp/fsck-signal-ready
echo "fsck phase: signal"
PATH=/tmp:$PATH FSCK_TEST_MODE=signal fsck -T -t test /tmp/fsck-dev1 &
fsck_parent=$!
(sleep 10; kill -KILL "$fsck_parent" 2>/dev/null) &
fsck_watchdog=$!
i=0
while [ ! -s /tmp/fsck-signal-ready ] && [ "$i" -lt 100 ]; do sleep .05; i=$((i + 1)); done
[ -s /tmp/fsck-signal-ready ] || fail "fsck signal child readiness"
sleep .2
kill -TERM "$fsck_parent" || fail "signal fsck"
wait "$fsck_parent"
fsck_rc=$?
kill "$fsck_watchdog" 2>/dev/null || true
[ "$fsck_rc" -ne 137 ] || fail "fsck signal wait timed out"
[ "$fsck_rc" -eq 0 ] || fail "fsck signal status $fsck_rc"
[ "$(cat /tmp/fsck-signal)" = TERM ] || fail "fsck did not signal checker"

cat >/tmp/fsck.ext4 <<'EOF'
#!/bin/sh
dev=
for arg do dev=$arg; done
case "${dev##*/}" in
fsck-dev1) sleep .2 ;;
fsck-dev2)
  trap 'echo USR1 >/tmp/fsck-progress; exit 0' USR1
  sleep 5
  exit 8
  ;;
esac
EOF
chmod +x /tmp/fsck.ext4
rm -f /tmp/fsck-progress
echo "fsck phase: progress"
PATH=/tmp:$PATH FSCK_FORCE_ALL_PARALLEL=1 \
  fsck -T -C0 -t ext4 /tmp/fsck-dev1 /tmp/fsck-dev2 || fail "fsck progress handoff"
[ "$(cat /tmp/fsck-progress)" = USR1 ] || fail "delayed fsck progress signal"

# The mmap-free dmesg file-input path parses a saved kernel log.
printf '6,1,1000,-;util-linux dmesg fixture\n' >/tmp/kmsg
dmesg_out=$(dmesg --file /tmp/kmsg)
contains "$dmesg_out" "util-linux dmesg fixture" ||
  fail "dmesg did not parse a saved kmsg file"

: >/tmp/kmsg-empty
dmesg --file /tmp/kmsg-empty >/dev/null 2>&1 &&
  fail "dmesg accepted an empty mmap replacement"
awk 'BEGIN { for (i = 0; i < 70000; i++) printf "x"; print "" }' >/tmp/kmsg-raw
dmesg --raw --file /tmp/kmsg-raw >/tmp/kmsg-raw.out || fail "dmesg raw file"
cmp /tmp/kmsg-raw /tmp/kmsg-raw.out || fail "dmesg raw multi-page output"

# The wasm heap path keeps look's native empty-file failure and handles a
# sorted dictionary spanning a page whose final line has no newline.
: >/tmp/look-empty
look key /tmp/look-empty >/dev/null 2>&1 && fail "look accepted empty dictionary"
awk 'BEGIN { for (i = 0; i < 10000; i++) printf "key%04d%s", i, i == 9999 ? "" : "\n" }' >/tmp/look-dict
[ "$(look key9999 /tmp/look-dict)" = key9999 ] || fail "look page-boundary dictionary"

# musl lacks a wrapper, so both paths exercise util-linux's raw cachestat
# syscall against the guest kernel implementation.
printf 'cached fincore fixture\n' >/tmp/fincore-file
cat /tmp/fincore-file >/dev/null
fincore -n -b -o FILE,PAGES,RES /tmp/fincore-file |
  awk '$1 == "/tmp/fincore-file" && $2 >= 1 && $3 >= 23 { ok = 1 } END { exit !ok }' ||
  fail "fincore cachestat path"
fincore --cachestat -n -b -o FILE,PAGES,RES /tmp/fincore-file |
  awk '$1 == "/tmp/fincore-file" && $2 >= 1 && $3 >= 23 { ok = 1 } END { exit !ok }' ||
  fail "fincore forced cachestat path"

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

# Process-only setup remains child-local and asynchronous on wasm.  These
# private upstream-source helpers exercise the same callback launchers used by
# switch_root cleanup and sulogin consoles.  ttymsg runs in the PTY check.
switch_cleanup=$(/test_switch_root) || fail "switch_root cleanup callback"
contains "$switch_cleanup" "concurrent=yes" ||
  fail "switch_root cleanup semantics: $switch_cleanup"
sulogin_result=$(/test_sulogin) || fail "sulogin console callbacks"
contains "$sulogin_result" "consoles=3,7" ||
  contains "$sulogin_result" "consoles=7,3" ||
  fail "sulogin console dispatch: $sulogin_result"

# Build and probe a real filesystem image through mkfs.minix and libblkid.
dd if=/dev/zero of=/tmp/minix.img bs=1024 count=256 2>/dev/null ||
  fail "creating minix image"
mkfs.minix /tmp/minix.img >/dev/null || fail "mkfs.minix"
blkid_type=$(blkid -p -s TYPE -o value /tmp/minix.img)
[ "$blkid_type" = minix ] || fail "blkid reported '$blkid_type' instead of minix"
contains "$(wipefs /tmp/minix.img)" "minix" ||
  fail "wipefs/libblkid did not list the minix signature"

# Cramfs remains useful as an offline image format. Exercise duplicate files,
# a symlink, and a file spanning multiple cramfs blocks through extraction.
mkdir -p /tmp/cram-src
rm -rf /tmp/cram-out
printf 'regular cramfs file\n' >/tmp/cram-src/regular
cp /tmp/cram-src/regular /tmp/cram-src/duplicate
ln -s regular /tmp/cram-src/link
awk 'BEGIN { for (i = 0; i < 70000; i++) printf "%c", 65 + (i % 26) }' >/tmp/cram-src/multiblock
printf 'embedded boot image\n' >/tmp/cram-embedded
: >/tmp/cram-empty
mkfs.cramfs -i /tmp/cram-empty /tmp/cram-src /tmp/cram-empty.img >/dev/null 2>&1 &&
  fail "mkfs.cramfs accepted empty embedded image"
dd if=/dev/null of=/tmp/cram-oversize bs=1 seek=2147483645 2>/dev/null ||
  fail "create sparse oversized embedded image"
mkfs.cramfs -i /tmp/cram-oversize /tmp/cram-src /tmp/cram-oversize.img >/dev/null 2>&1 &&
  fail "mkfs.cramfs accepted oversized embedded image"
mkfs.cramfs /tmp/cram-src /tmp/cram.img || fail "mkfs.cramfs"
fsck.cramfs -v /tmp/cram.img >/tmp/cram.list || fail "fsck.cramfs verify"
contains "$(cat /tmp/cram.list)" "/tmp/cram.img: OK" ||
  fail "fsck.cramfs verification output"
fsck.cramfs --extract=/tmp/cram-out /tmp/cram.img || fail "fsck.cramfs extract"
cmp /tmp/cram-src/regular /tmp/cram-out/regular || fail "cramfs regular extract"
cmp /tmp/cram-src/duplicate /tmp/cram-out/duplicate || fail "cramfs duplicate extract"
cmp /tmp/cram-src/multiblock /tmp/cram-out/multiblock || fail "cramfs multiblock extract"
[ "$(readlink /tmp/cram-out/link)" = regular ] || fail "cramfs symlink extract"
# An embedded image starts immediately after the 76-byte cramfs_super.  This
# util-linux fsck predates support for the shifted-root flag produced by -i,
# so validate that independent mkfs path directly rather than weakening fsck.
mkfs.cramfs -i /tmp/cram-embedded /tmp/cram-src /tmp/cram-with-embedded.img ||
  fail "mkfs.cramfs embedded image"
embedded_size=$(wc -c </tmp/cram-embedded)
dd if=/tmp/cram-with-embedded.img of=/tmp/cram-embedded.out bs=1 skip=76 \
  count="$embedded_size" 2>/dev/null || fail "read embedded cramfs image"
cmp /tmp/cram-embedded /tmp/cram-embedded.out || fail "cramfs embedded image"
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
