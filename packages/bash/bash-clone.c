#define _GNU_SOURCE

#include "bash-clone.h"

#include <errno.h>
#include <sched.h>
#include <signal.h>
#include <stdlib.h>

pid_t
bash_clone (int (*child_func) (void *), void *arg)
{
  enum { CHILD_STACK_SIZE = 128 * 1024 };
  void *child_stack;
  pid_t pid;
  int errno_save;

  child_stack = malloc (CHILD_STACK_SIZE);
  if (child_stack == NULL)
    return -1;

  pid = clone (child_func, (char *)child_stack + CHILD_STACK_SIZE, SIGCHLD,
               arg);
  errno_save = errno;
  free (child_stack);
  errno = errno_save;
  return pid;
}
