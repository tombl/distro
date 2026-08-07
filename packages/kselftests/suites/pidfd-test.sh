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

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

pidfd_open_test || fail "pidfd_open_test failed"

out=$(pidfd_test 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "pidfd_test exited $rc"
echo "$out" | grep -q '^1\.\.5$' || fail "pidfd_test reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|# SKIP' && fail "pidfd_test reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 5 ] || fail "pidfd_test did not pass all five tests"

echo "::vm-test::pass"
while :; do :; done
