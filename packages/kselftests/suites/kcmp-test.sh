#!/bin/busybox sh

# kcmp_test compares fd, VM, and epoll state across a libc clone() child and its
# parent. The source patch replaces the unavailable fork() call while preserving
# process semantics and makes the parent propagate the child's kselftest result.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

kcmp_test
rc=$?
[ "$rc" -eq 0 ] || fail "kcmp_test exited $rc"

echo "::vm-test::pass"
while :; do :; done
