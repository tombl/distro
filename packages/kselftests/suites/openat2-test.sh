#!/bin/busybox sh

# openat2_test drives the openat2 syscall directly: it checks open_how size and
# reserved-field validation, the RESOLVE_* flag combinations, and path
# resolution against files it creates in the cwd. No process fork, no mmap.
#
# The suite's other binaries are held out:
#   * resolve_test       - unshare(CLONE_NEWNS) + mount tmpfs; mount namespaces
#                          are not configured and tmpfs needs MMU-backed shmem.
#   * rename_attack_test - fork()s an attacker child, and fork() does not exist
#                          on wasm (see kcmp.nix).

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

cd /tmp || fail "cd /tmp failed"
openat2_test
rc=$?
[ "$rc" -eq 0 ] || fail "openat2_test exited $rc"

echo "::vm-test::pass"
while :; do :; done
