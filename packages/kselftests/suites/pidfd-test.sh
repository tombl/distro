#!/bin/busybox sh

# pidfd_open_test opens a pidfd for its own process and reads the pid back out of
# /proc/self/fdinfo, plus the two rejection paths (invalid pid, invalid flag).
# pidfd_test exercises CLONE_PIDFD through libc clone(), pidfd readiness through
# epoll and waitpid, and pidfd_send_signal. The source patch holds out only its
# namespace/PID-recycling and shared-mmap cases.
#
# The rest of the pidfd suite is held out:
#   * pidfd_poll_test, pidfd_getfd_test - fork() an auxiliary process; fork() does
#                                         not exist on wasm.
#   * pidfd_wait                         - drives the raw clone3 stack ABI, which
#                                         the wasm custom fn/fn_arg clone does not
#                                         implement (skipped on principle).
#   * pidfd_fdinfo_test, pidfd_setns_test - need PID/USER/NET/... namespaces,
#                                           which are not configured.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

for test in pidfd_open_test pidfd_test; do
  "$test"
  rc=$?
  [ "$rc" -eq 0 ] || fail "$test exited $rc"
done

echo "::vm-test::pass"
while :; do :; done
