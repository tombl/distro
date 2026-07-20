#!/bin/busybox sh

# mq_open_tests opens POSIX message queues with a matrix of attribute structs and
# checks the kernel's default/max clamping and EINVAL paths, reading the limits
# from /proc/sys/fs/mqueue. No fork, thread, or mmap. It runs as root here, so
# its root-only cases are exercised too.
#
# mq_perf_tests is held out: it is a benchmark that pins itself to CPUs, links
# against -lpopt (absent from the sysroot), and measures latency rather than
# asserting correctness.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

mq_open_tests /test-queue
rc=$?
[ "$rc" -eq 0 ] || fail "mq_open_tests exited $rc"

echo "::vm-test::pass"
while :; do :; done
