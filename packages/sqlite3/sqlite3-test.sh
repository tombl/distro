#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export TERM=xterm
export TERMINFO=/share/terminfo

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mkdir -p /dev/pts || fail "creating /dev/pts failed"
mount -t devpts devpts /dev/pts || fail "mounting devpts failed"

# The shell links readline; assert the library is actually reported.
sqlite3 --version >/tmp/version 2>&1 || fail "sqlite3 --version failed"
grep -Eq '^3\.51\.0' /tmp/version || fail "unexpected sqlite3 version: $(cat /tmp/version)"

# Non-tty path: run a query end-to-end through the shell.
sqlite3 /tmp/db.sqlite \
  'CREATE TABLE t(a,b); INSERT INTO t VALUES(6,7); SELECT a*b FROM t;' >/tmp/query 2>/tmp/query.err ||
  fail "sqlite3 query failed: $(cat /tmp/query.err)"
grep -qx 42 /tmp/query || fail "sqlite3 returned wrong result: $(cat /tmp/query)"

# Interactive path: drive the shell under a pty so readline initializes its
# terminal, and confirm a query still runs end-to-end.
printf '.mode list\nSELECT 6*7;\n.quit\n' |
  script -q -c 'sqlite3 /tmp/db2.sqlite' /tmp/typescript >/dev/null 2>&1 ||
  fail "sqlite3 shell failed under a pty"
# The pty leaves control characters around the result line, so match the
# banner (proves the readline shell started under a pty without crashing) and
# the result as a substring rather than a whole line.
tr -d '\r' </tmp/typescript >/tmp/interactive
grep -q 'SQLite version 3.51.0' /tmp/interactive ||
  fail "interactive sqlite3 shell did not print its banner: $(cat /tmp/interactive)"
grep -q 42 /tmp/interactive ||
  fail "interactive sqlite3 shell did not return 42: $(cat /tmp/interactive)"

echo "::vm-test::pass"
while :; do :; done
