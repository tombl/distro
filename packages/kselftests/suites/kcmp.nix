# kcmp: the syscall and epoll dependency are enabled by syscalls.config. The
# source patch replaces fork() with libc clone(), deliberately exercising the
# wasm fn/fn_arg ABI with fork-like process semantics.
{
  dir = "tools/testing/selftests/kcmp";
  binaries = [ "kcmp_test" ];
  run = ./kcmp-test.sh;
}
