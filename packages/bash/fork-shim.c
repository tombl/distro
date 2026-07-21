#include <sys/types.h>
#include <unistd.h>

/*
 * Link-only guard for fork sites that have not yet been converted to the
 * callback form required by wasm Linux.  This must stay loud: returning an
 * error would make Bash silently take ordinary fork-failure paths and hide an
 * unsupported execution shape.
 */
pid_t
fork (void)
{
  static const char message[] =
    "bash: unconverted fork() call reached on wasm Linux\n";

  (void)write (STDERR_FILENO, message, sizeof (message) - 1);
  __builtin_trap ();
}
