# mqueue: POSIX message queues, enabled by CONFIG_POSIX_MQUEUE in
# syscalls.config. Only mq_open_tests is built: it exercises mq_open attribute
# validation with no fork, thread, or mmap. mq_perf_tests is held out (see
# mqueue-test.sh). The Makefile's LDLIBS pulls in -lpopt, which the sysroot has
# no library for; overriding LDLIBS drops it (mq_* and the rt stub are folded
# into musl's libc, so -lrt alone links).
{
  dir = "tools/testing/selftests/mqueue";
  binaries = [ "mq_open_tests" ];
  makeFlags = [ "LDLIBS=-lrt" ];
  run = ./mqueue-test.sh;
}
