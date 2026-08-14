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

[ ! -e /libexec/util-linux-tests ] ||
  fail "private util-linux test helpers leaked into the production output"
[ ! -d /proc/sysvipc ] ||
  fail "System V IPC proc interface unexpectedly exists"

programs='
addpart agetty bits blkdiscard blkid blkpr blkzone blockdev cal cfdisk
choom chrt colcrt colrm column copyfilerange
ctrlaltdel delpart dmesg exch fallocate fdisk fincore findfs
findmnt flock fsck fsck.cramfs fsck.minix fsfreeze fstrim getino getopt hardlink
hexdump ionice irqtop isosize kill last lastb
lastlog2 linux32 linux64 logger look losetup lsblk lsclocks lscpu
lsfd lsirq lslocks lslogins lsmem lsns mcookie mesg mkfs mkfs.bfs
mkfs.cramfs mkfs.minix mkswap more mount mountpoint namei nologin nsenter partx pipesz
pivot_root prlimit readprofile rename renice resizepart rev
script scriptlive scriptreplay setarch setpgid setsid setterm sfdisk sulogin
swaplabel switch_root taskset ul umount uname26
unshare utmpdump uuidd uuidgen uuidparse waitpid wall whereis wipefs
'

for program in $programs; do
  path=
  for directory in /bin /sbin; do
    [ -x "$directory/$program" ] && path="$directory/$program"
  done
  [ -n "$path" ] || fail "$program is missing"
done

for program in swapon swapoff eject fadvise ldattach ipcmk ipcrm ipcs lsipc \
  coresched uclampset zramctl rfkill wdctl hwclock rtcwake chmem chcpu; do
  [ ! -e "/bin/$program" ] && [ ! -e "/sbin/$program" ] ||
    fail "$program should be disabled for the target kernel/device configuration"
done

wait_uuidd_ready() {
  socket=$1
  pidfile=$2
  i=0
  while { [ ! -S "$socket" ] || [ ! -s "$pidfile" ]; } && [ "$i" -lt 100 ]; do
    sleep .05
    i=$((i + 1))
  done
  [ "$i" -lt 100 ] || fail "uuidd did not create $socket and $pidfile"
}

wait_uuidd_exit() {
  pid=$1
  label=$2
  i=0
  while kill -0 "$pid" 2>/dev/null &&
    [ "$(awk '{ print $3 }' "/proc/$pid/stat" 2>/dev/null)" != Z ] &&
    [ "$i" -lt 100 ]; do
    sleep .05
    i=$((i + 1))
  done
  [ "$i" -lt 100 ] || fail "uuidd $label process $pid did not exit"
}

reap_uuidd_foreground() {
  pid=$1
  label=$2
  wait "$pid"
  rc=$?
  [ "$rc" -eq 0 ] || fail "uuidd $label exit status $rc"
}

check_uuid() {
  value=$1
  version=$2
  case "$value" in
  ????????-????-"$version"???-[89aAbB]???-????????????) ;;
  *) fail "uuidd returned invalid version $version UUID: $value" ;;
  esac
}

monotonic_msec() {
  awk '{ printf "%d\n", $1 * 1000 }' /proc/uptime
}

# irqtop uses an absolute monotonic deadline on wasm.  Two iterations mean
# exactly the immediate snapshot and one delayed snapshot, without drift or a
# timerfd dependency.
irqtop_start=$(monotonic_msec)
irqtop -b -c never -n 2 -d .1 >/tmp/irqtop-two.out ||
  fail "irqtop two-snapshot batch run"
irqtop_end=$(monotonic_msec)
irqtop_elapsed=$((irqtop_end - irqtop_start))
[ "$(awk '/^irqtop \| total:/ { count++ } END { print count + 0 }' /tmp/irqtop-two.out)" -eq 2 ] ||
  fail "irqtop did not emit exactly two snapshots"
[ "$irqtop_elapsed" -ge 50 ] && [ "$irqtop_elapsed" -lt 1000 ] ||
  fail "irqtop .1 second interval took ${irqtop_elapsed}ms"
irqtop -b -n 2 -d 0 >/dev/null 2>&1 && fail "irqtop accepted a zero delay"

# Keep a pollable stdin open while irqtop runs asynchronously.  WINCH requests
# a refresh and must not terminate the process; TERM must take the normal exit
# path and return success promptly.
rm -f /tmp/irqtop-input
mkfifo /tmp/irqtop-input || fail "create irqtop input fifo"
exec 9<>/tmp/irqtop-input
irqtop -b -c never -d 10 <&9 >/tmp/irqtop-signals.out &
irqtop_pid=$!
sleep .1
kill -WINCH "$irqtop_pid" || fail "signal irqtop SIGWINCH"
sleep .1
kill -0 "$irqtop_pid" 2>/dev/null || fail "irqtop exited on SIGWINCH"
irqtop_term_start=$(monotonic_msec)
kill -TERM "$irqtop_pid" || fail "signal irqtop SIGTERM"
wait "$irqtop_pid"
irqtop_rc=$?
irqtop_term_end=$(monotonic_msec)
exec 9>&-
[ "$irqtop_rc" -eq 0 ] || fail "irqtop SIGTERM status $irqtop_rc"
[ "$((irqtop_term_end - irqtop_term_start))" -lt 1000 ] ||
  fail "irqtop did not exit promptly on SIGTERM"

# waitpid keeps pidfds in epoll on wasm and implements only the unavailable
# timerfd with epoll's timeout argument.  Exercise success, timeout precision,
# an interrupted wait, multi-process count, and the documented zero-timeout
# spelling (which disables the timeout).
/test_waitpid_timeout || fail "waitpid capped-deadline boundary helper"

sleep .1 &
waitpid_child=$!
waitpid -t 2 "$waitpid_child" || fail "waitpid exit before timeout"
wait "$waitpid_child" 2>/dev/null

sleep 5 &
waitpid_child=$!
waitpid_start=$(monotonic_msec)
waitpid -v -t .5 "$waitpid_child" >/tmp/waitpid-timeout.out
waitpid_rc=$?
waitpid_end=$(monotonic_msec)
waitpid_elapsed=$((waitpid_end - waitpid_start))
[ "$waitpid_rc" -eq 3 ] || fail "waitpid timeout status $waitpid_rc"
[ "$(cat /tmp/waitpid-timeout.out)" = "Timeout expired" ] ||
  fail "waitpid verbose timeout output: $(cat /tmp/waitpid-timeout.out)"
[ "$waitpid_elapsed" -ge 450 ] ||
  fail "waitpid fractional timeout fired early (${waitpid_elapsed}ms)"
kill -0 "$waitpid_child" 2>/dev/null || fail "waitpid timeout killed its target"
kill "$waitpid_child" || fail "stop waitpid timeout child"
wait "$waitpid_child" 2>/dev/null

# SIGCONT interrupts a blocking epoll_wait after the waiter is stopped.  The
# absolute deadline must continue to elapse while stopped rather than restart.
sleep 5 &
waitpid_child=$!
waitpid_start=$(monotonic_msec)
waitpid -v -t .5 "$waitpid_child" >/tmp/waitpid-eintr.out &
waitpid_waiter=$!
sleep .2
kill -STOP "$waitpid_waiter" || fail "stop waitpid EINTR waiter"
sleep .4
waitpid_cont=$(monotonic_msec)
kill -CONT "$waitpid_waiter" || fail "continue waitpid EINTR waiter"
wait "$waitpid_waiter"
waitpid_rc=$?
waitpid_end=$(monotonic_msec)
waitpid_elapsed=$((waitpid_end - waitpid_start))
waitpid_after_cont=$((waitpid_end - waitpid_cont))
[ "$waitpid_rc" -eq 3 ] || fail "waitpid EINTR timeout status $waitpid_rc"
[ "$(cat /tmp/waitpid-eintr.out)" = "Timeout expired" ] ||
  fail "waitpid EINTR verbose output: $(cat /tmp/waitpid-eintr.out)"
[ "$waitpid_elapsed" -ge 450 ] && [ "$waitpid_after_cont" -lt 400 ] ||
  fail "waitpid EINTR changed deadline (${waitpid_elapsed}ms total, ${waitpid_after_cont}ms after CONT)"
kill -0 "$waitpid_child" 2>/dev/null || fail "waitpid EINTR killed its target"
kill "$waitpid_child" || fail "stop waitpid EINTR child"
wait "$waitpid_child" 2>/dev/null

sleep 1 & waitpid_child_a=$!
sleep 1.5 & waitpid_child_b=$!
waitpid -v -c 2 -t 3 "$waitpid_child_a" "$waitpid_child_b" \
  >/tmp/waitpid-count.out ||
  fail "waitpid count across two children"
[ "$(awk '/^PID [0-9]+ finished$/ { count++ } END { print count + 0 }' /tmp/waitpid-count.out)" -eq 2 ] ||
  fail "waitpid count completion records: $(cat /tmp/waitpid-count.out)"
contains "$(cat /tmp/waitpid-count.out)" "PID $waitpid_child_a finished" ||
  fail "waitpid omitted first counted PID"
contains "$(cat /tmp/waitpid-count.out)" "PID $waitpid_child_b finished" ||
  fail "waitpid omitted second counted PID"

sleep .2 &
waitpid_child=$!
waitpid -t 0 "$waitpid_child" || fail "waitpid zero timeout was not disabled"
wait "$waitpid_child" 2>/dev/null

sleep .2 &
waitpid_child=$!
waitpid "$waitpid_child" || fail "waitpid without timeout"
wait "$waitpid_child" 2>/dev/null

# The foreground service must answer real protocol requests, ignore SIGPIPE,
# and remove both ownership files on a terminating signal.
mkdir -p /var/lib/libuuid || fail "create uuidd clock state directory"
echo "uuidd phase: foreground TERM"
uuidd_socket=/tmp/uuidd-foreground.sock
uuidd_pidfile=/tmp/uuidd-foreground.pid
rm -f "$uuidd_socket" "$uuidd_pidfile"
uuidd -F -s "$uuidd_socket" -p "$uuidd_pidfile" &
uuidd_launcher_pid=$!
wait_uuidd_ready "$uuidd_socket" "$uuidd_pidfile"
uuidd_pid=$(awk '{ print $1 }' "$uuidd_pidfile")
[ "$uuidd_pid" -eq "$uuidd_launcher_pid" ] ||
  fail "uuidd foreground pidfile does not identify its launcher"
check_uuid "$(timeout 5 uuidd -s "$uuidd_socket" -r)" 4
check_uuid "$(timeout 5 uuidd -s "$uuidd_socket" -t)" 1
uuidd_bulk=$(timeout 5 uuidd -s "$uuidd_socket" -r -n 3) ||
  fail "uuidd bulk random request"
contains "$uuidd_bulk" "List of UUIDs:" || fail "uuidd bulk reply header"
[ "$(printf '%s\n' "$uuidd_bulk" | awk 'NR > 1 { count++ } END { print count }')" -eq 3 ] ||
  fail "uuidd bulk reply count: $uuidd_bulk"
kill -PIPE "$uuidd_pid" || fail "signal uuidd SIGPIPE"
sleep .1
kill -0 "$uuidd_pid" 2>/dev/null || fail "uuidd exited on SIGPIPE"
check_uuid "$(timeout 5 uuidd -s "$uuidd_socket" -r)" 4
kill -TERM "$uuidd_pid" || fail "signal uuidd SIGTERM"
wait_uuidd_exit "$uuidd_pid" foreground-TERM
reap_uuidd_foreground "$uuidd_launcher_pid" SIGTERM
[ ! -e "$uuidd_socket" ] && [ ! -e "$uuidd_pidfile" ] ||
  fail "uuidd SIGTERM did not clean socket and pidfile"

# An asynchronously launched shell command inherits SIGHUP ignored in this
# environment.  Use a normal daemon launch to exercise HUP with its real
# startup disposition; ALRM does not have that shell-job exception.
uuidd_socket=/tmp/uuidd-HUP.sock
echo "uuidd phase: daemon HUP"
uuidd_pidfile=/tmp/uuidd-HUP.pid
rm -f "$uuidd_socket" "$uuidd_pidfile"
uuidd -s "$uuidd_socket" -p "$uuidd_pidfile" || fail "launch uuidd for SIGHUP"
wait_uuidd_ready "$uuidd_socket" "$uuidd_pidfile"
uuidd_pid=$(awk '{ print $1 }' "$uuidd_pidfile")
kill -HUP "$uuidd_pid" || fail "signal uuidd SIGHUP"
wait_uuidd_exit "$uuidd_pid" daemon-HUP
[ ! -e "$uuidd_socket" ] && [ ! -e "$uuidd_pidfile" ] ||
  fail "uuidd SIGHUP did not clean socket and pidfile"

uuidd_socket=/tmp/uuidd-ALRM.sock
echo "uuidd phase: foreground ALRM"
uuidd_pidfile=/tmp/uuidd-ALRM.pid
rm -f "$uuidd_socket" "$uuidd_pidfile"
uuidd -F -s "$uuidd_socket" -p "$uuidd_pidfile" &
uuidd_launcher_pid=$!
wait_uuidd_ready "$uuidd_socket" "$uuidd_pidfile"
uuidd_pid=$(awk '{ print $1 }' "$uuidd_pidfile")
kill -ALRM "$uuidd_pid" || fail "signal uuidd SIGALRM"
wait_uuidd_exit "$uuidd_pid" foreground-ALRM
reap_uuidd_foreground "$uuidd_launcher_pid" SIGALRM
[ ! -e "$uuidd_socket" ] && [ ! -e "$uuidd_pidfile" ] ||
  fail "uuidd SIGALRM did not clean socket and pidfile"

# An asynchronously launched shell command inherits SIGINT ignored, so test
# INT on the normally launched daemon child, whose inherited disposition is
# the service's real startup disposition.
uuidd_socket=/tmp/uuidd-int.sock
echo "uuidd phase: daemon INT"
uuidd_pidfile=/tmp/uuidd-int.pid
rm -f "$uuidd_socket" "$uuidd_pidfile"
uuidd -s "$uuidd_socket" -p "$uuidd_pidfile" || fail "launch uuidd for SIGINT"
wait_uuidd_ready "$uuidd_socket" "$uuidd_pidfile"
uuidd_pid=$(awk '{ print $1 }' "$uuidd_pidfile")
kill -INT "$uuidd_pid" || fail "signal uuidd SIGINT"
wait_uuidd_exit "$uuidd_pid" daemon-INT
[ ! -e "$uuidd_socket" ] && [ ! -e "$uuidd_pidfile" ] ||
  fail "uuidd SIGINT did not clean socket and pidfile"

# Inactivity is a normal clean shutdown. A timeout larger than poll(2)'s
# millisecond range must retain its full duration rather than wrapping.
uuidd_socket=/tmp/uuidd-timeout.sock
echo "uuidd phase: foreground inactivity"
uuidd_pidfile=/tmp/uuidd-timeout.pid
rm -f "$uuidd_socket" "$uuidd_pidfile"
uuidd -F -T 1 -s "$uuidd_socket" -p "$uuidd_pidfile" &
uuidd_launcher_pid=$!
wait_uuidd_ready "$uuidd_socket" "$uuidd_pidfile"
uuidd_pid=$(awk '{ print $1 }' "$uuidd_pidfile")
wait_uuidd_exit "$uuidd_pid" foreground-inactivity
reap_uuidd_foreground "$uuidd_launcher_pid" inactivity
[ ! -e "$uuidd_socket" ] && [ ! -e "$uuidd_pidfile" ] ||
  fail "uuidd inactivity did not clean socket and pidfile"
uuidd_socket=/tmp/uuidd-long-timeout.sock
echo "uuidd phase: foreground long timeout"
uuidd_pidfile=/tmp/uuidd-long-timeout.pid
rm -f "$uuidd_socket" "$uuidd_pidfile"
uuidd -F -T 4294967295 -s "$uuidd_socket" -p "$uuidd_pidfile" &
uuidd_launcher_pid=$!
wait_uuidd_ready "$uuidd_socket" "$uuidd_pidfile"
uuidd_pid=$(awk '{ print $1 }' "$uuidd_pidfile")
sleep .1
kill -0 "$uuidd_pid" 2>/dev/null || fail "uuidd long timeout wrapped"
check_uuid "$(timeout 5 uuidd -s "$uuidd_socket" -r)" 4
kill -TERM "$uuidd_pid" || fail "stop uuidd long-timeout service"
wait_uuidd_exit "$uuidd_pid" foreground-long-timeout
reap_uuidd_foreground "$uuidd_launcher_pid" long-timeout
[ ! -e "$uuidd_socket" ] && [ ! -e "$uuidd_pidfile" ] ||
  fail "uuidd long-timeout shutdown did not clean service files"

# Default daemon mode retains the double-fork topology: the final service is
# reparented, is not its session leader, runs from / with /dev/null stdio, and
# remains a fully functional protocol server until uuidd --kill shuts it down.
uuidd_socket=/tmp/uuidd-daemon.sock
echo "uuidd phase: daemon shutdown"
uuidd_pidfile=/tmp/uuidd-daemon.pid
rm -f "$uuidd_socket" "$uuidd_pidfile"
uuidd -s "$uuidd_socket" -p "$uuidd_pidfile" || fail "launch uuidd daemon"
wait_uuidd_ready "$uuidd_socket" "$uuidd_pidfile"
uuidd_pid=$(awk '{ print $1 }' "$uuidd_pidfile")
kill -0 "$uuidd_pid" 2>/dev/null || fail "uuidd daemon pid is not live"
uuidd_ppid=$(awk '$1 == "PPid:" { print $2 }' "/proc/$uuidd_pid/status")
[ "$uuidd_ppid" -eq 1 ] || fail "uuidd daemon was not reparented: ppid=$uuidd_ppid"
uuidd_session=$(awk '{ print $6 }' "/proc/$uuidd_pid/stat")
[ "$uuidd_session" -ne "$uuidd_pid" ] || fail "uuidd final daemon is session leader"
[ "$(readlink "/proc/$uuidd_pid/cwd")" = / ] || fail "uuidd daemon cwd is not /"
for uuidd_fd in 0 1 2; do
  [ "$(readlink "/proc/$uuidd_pid/fd/$uuidd_fd")" = /dev/null ] ||
    fail "uuidd daemon fd $uuidd_fd is not /dev/null"
done
check_uuid "$(timeout 5 uuidd -s "$uuidd_socket" -r)" 4
check_uuid "$(timeout 5 uuidd -s "$uuidd_socket" -t)" 1
timeout 5 uuidd -k -s "$uuidd_socket" || fail "stop uuidd daemon"
wait_uuidd_exit "$uuidd_pid" daemon-shutdown
[ ! -e "$uuidd_socket" ] && [ ! -e "$uuidd_pidfile" ] ||
  fail "uuidd daemon shutdown did not clean socket and pidfile"

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
ns_inode=$(stat -Lc %i "/proc/$ns_pid/ns/mnt") ||
  fail "stat held mount namespace"
lsns -t mnt -n -o NS,NPROCS,PID -p "$ns_pid" |
  awk -v inode="$ns_inode" -v pid="$ns_pid" \
    '$1 == inode && $2 >= 1 && $3 == pid { found = 1 } END { exit !found }' ||
  fail "lsns did not report held namespace inode $ns_inode with PID $ns_pid"
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
