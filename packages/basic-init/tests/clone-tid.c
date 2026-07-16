#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

struct child_args {
	pid_t *child_tid;
};

static int child(void *arg)
{
	struct child_args *args = arg;

	if (*args->child_tid != getpid())
		_exit(1);
	return 0;
}

int main(void)
{
	const size_t stack_size = 64 * 1024;
	char *stack = malloc(stack_size);
	pid_t parent_tid = -1;
	pid_t child_tid = -1;
	struct child_args args = { .child_tid = &child_tid };
	int status;
	pid_t pid;

	if (!stack)
		test_perror("malloc");

	pid = clone(child, stack + stack_size,
		    CLONE_VM | CLONE_VFORK | CLONE_PARENT_SETTID |
			    CLONE_CHILD_SETTID | SIGCHLD,
		    &args, &parent_tid, &child_tid);
	if (pid == -1)
		test_perror("clone");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("child TID was not set");
	if (parent_tid != pid)
		test_fail("parent TID was not set");

	free(stack);
	test_pass();
}
