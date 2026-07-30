#!/bin/busybox sh

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /tmp || fail "could not create /tmp"
rust-smoke --process-exec >/tmp/rust-process-exec || fail "CommandExt::exec exited with $?"
[ "$(cat /tmp/rust-process-exec)" = "EXEC OK" ] || fail "CommandExt::exec output was wrong"
rust-smoke one two three || fail "rust-smoke exited with $?"

echo "::vm-test::pass"
while :; do :; done
