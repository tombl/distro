# futex/functional: chosen first because its core syscall is wired here
# (CONFIG_FUTEX=y, CONFIG_FUTEX_PI=y). Only the binary the check runs is built;
# the rest lean on mmap, SysV shm, signal-interrupted syscalls, or the tabled
# futex_waitv EFAULT bug (see futex-test.sh for the per-binary rationale).
{
  dir = "tools/testing/selftests/futex/functional";
  binaries = [ "futex_requeue_pi_mismatched_ops" ];
  run = ./futex-test.sh;
}
