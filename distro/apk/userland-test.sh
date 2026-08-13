#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs"
mount -t proc proc /proc || fail "mounting proc"

apk --allow-untrusted \
  --repository /repo/wasm32/Packages.adb \
  add bash coreutils file openssl || fail "installing userland packages"

[ "$(readlink /bin/sh)" = busybox ] || fail "/bin/sh is not BusyBox"
apk info --who-owns /bin/sh | grep -q 'owned by busybox-' || fail "BusyBox does not own /bin/sh"
bash -c 'test "$BASH_VERSION" != ""' || fail "Bash does not run beside BusyBox"

[ -s /etc/ssl/cert.pem ] || fail "CA certificate bundle is missing"
apk info --who-owns /etc/ssl/cert.pem | grep -q 'owned by ca-certificates-' ||
  fail "ca-certificates does not exclusively own the trust bundle"
openssl version | grep -q '^OpenSSL 3.5.7' || fail "OpenSSL does not run beside apk-tools"

ls --version >/tmp/ls-version || fail "ls --version failed"
grep -q 'GNU coreutils' /tmp/ls-version || fail "coreutils does not own /bin/ls"
/bin/kill --version | grep -q 'GNU coreutils' || fail "coreutils does not own /bin/kill"
apk info --who-owns /bin/kill | grep -q 'owned by coreutils-' || fail "coreutils does not own /bin/kill"

[ -f /share/terminfo/x/xterm ] || fail "ncurses terminfo is missing"
[ -f /usr/share/misc/magic.mgc ] || fail "file magic database is missing"

echo "::vm-test::pass"
while :; do :; done
