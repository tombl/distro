#!/bin/busybox sh

fail() {
  echo "::vm-test::fail: $*"
  while :; do :; done
}

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"

i=0
while [ ! -b /dev/vda ]; do
  [ "$i" -lt 100 ] || fail "timed out waiting for /dev/vda"
  i=$((i + 1))
  sleep 0.1
done

mkdir -p /newroot || fail "creating mountpoint failed"
mount -t squashfs -o ro /dev/vda /newroot || fail "mounting site rootfs failed"
mount -t tmpfs tmpfs /newroot/tmp || fail "mounting writable tmp"
mount --bind /dev /newroot/dev || fail "mounting dev in rootfs"

check_runs() {
  command=$1
  shift
  /usr/sbin/chroot /newroot "/bin/$command" "$@" >/dev/null 2>&1 || fail "$command failed"
}

check_runs sqlite3 --version
check_runs jq --version
check_runs git --version
check_runs vim --version
check_runs less --version
check_runs curl --version

[ -s /newroot/share/terminfo/x/xterm-256color ] || fail "xterm-256color terminfo is missing"
mkdir -p /newroot/dev/pts || fail "creating devpts mountpoint failed"
mount -t devpts devpts /newroot/dev/pts || fail "mounting devpts failed"
seq 1 100 >/newroot/tmp/pager.txt || fail "creating pager input failed"
printf 'q' | TERM=xterm-256color /usr/sbin/chroot /newroot \
  /usr/bin/script -q -c 'less /tmp/pager.txt' /dev/null \
  >/newroot/tmp/less-terminal 2>&1 ||
  fail "interactive less session failed: $(cat /newroot/tmp/less-terminal)"
grep -q '1' /newroot/tmp/less-terminal || fail "less did not render its input"
grep -q 'terminal is not fully functional' /newroot/tmp/less-terminal &&
  fail "less could not load xterm-256color capabilities"

[ -x /newroot/usr/libexec/git-core/git-remote-http ] || fail "git HTTP transport is missing"
[ -L /newroot/usr/libexec/git-core/git-remote-https ] || fail "git HTTPS transport is missing"
[ -s /newroot/etc/ssl/certs/ca-certificates.crt ] || fail "curl CA bundle is missing"
[ "$(/usr/sbin/chroot /newroot /bin/git --exec-path)" = /usr/libexec/git-core ] ||
  fail "git reports the wrong exec path"
/usr/sbin/chroot /newroot /bin/git init /tmp/repository >/dev/null 2>&1 || fail "git init failed"

echo "::vm-test::pass"
while :; do :; done
