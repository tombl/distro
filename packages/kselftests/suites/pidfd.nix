# pidfd: pidfd_open is always compiled in (no config gate). pidfd_open_test
# validates its argument checks and /proc fdinfo. pidfd_test exercises
# CLONE_PIDFD through libc clone(), pidfd polling, and pidfd_send_signal; its
# namespace-only case is removed by the wasm compatibility patch.
{
  dir = "tools/testing/selftests/pidfd";
  binaries = [
    "pidfd_open_test"
    "pidfd_test"
  ];
  run = ./pidfd-test.sh;
}
