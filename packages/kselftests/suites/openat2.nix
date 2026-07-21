# openat2: the syscall is always compiled in (no config gate). Only openat2_test
# is built — it validates the open_how struct and RESOLVE_* flag handling with
# plain syscalls and needs no process or memory primitive. Its uapi header
# (linux/openat2.h) reaches the compile via USERCFLAGS (its Makefile does not
# wire KHDR_INCLUDES). The other two binaries are held out (see openat2-test.sh):
# resolve_test needs mount namespaces + tmpfs, rename_attack_test needs fork().
{
  dir = "tools/testing/selftests/openat2";
  binaries = [ "openat2_test" ];
  run = ./openat2-test.sh;
}
