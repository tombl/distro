#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export TERM=xterm

mount -t proc proc /proc || fail "mounting proc failed"

apk --version | grep -q 'apk-tools 3.0.5' || fail "unexpected apk version"
apk --allow-untrusted \
  --repository /repo/wasm32/Packages.adb \
  add --initdb jq lua apk-script-test || fail "installing packages"

printf '%s\n' installed-through-apk >/tmp/persistent
sync

[ -x /bin/jq ] || fail "jq was not installed"
jq_version=$(/bin/jq --version 2>&1)
echo "$jq_version" | grep -q '^jq-1.7.1$' || fail "jq does not run: $jq_version"
[ -x /bin/lua ] || fail "lua was not installed"
lua_version=$(/bin/lua -v 2>&1)
echo "$lua_version" | grep -q '^Lua 5.4.8' || fail "lua does not run: $lua_version"
[ -f /share/apk-script-test/payload ] || fail "script test payload was not installed"
[ "$(cat /apk-script-ran 2>/dev/null)" = 'maintainer script ran' ] ||
  fail "post-install script did not run through callback clone"
apk query --installed --fields name jq lua apk-script-test >/tmp/installed ||
  fail "querying installed database"
grep -q 'jq' /tmp/installed || fail "jq missing from installed database"
grep -q 'lua' /tmp/installed || fail "lua missing from installed database"

echo "::vm-test::pass"
while :; do :; done
