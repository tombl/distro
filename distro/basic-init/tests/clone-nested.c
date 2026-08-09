#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

enum {
	max_depth = 8,
	stack_size = 64 * 1024,
};

static _Alignas(16) char nested_stacks[max_depth][stack_size];

struct child_args {
	int depth;
};

static int nested_child(void *opaque)
{
	struct child_args *args = opaque;
	struct child_args next = { .depth = args->depth + 1 };
	int status;
	pid_t pid;

	if (args->depth == max_depth)
		return 23;
	pid = clone(nested_child, nested_stacks[args->depth] + stack_size,
	            SIGCHLD, &next);
	if (pid == -1) {
		printf("nested clone: failed at depth=%d errno=%d (%s)\n",
		       next.depth, errno, strerror(errno));
		return 1;
	}
	if (waitpid(pid, &status, 0) == -1)
		return 2;
	if (!WIFEXITED(status))
		return 3;
	return WEXITSTATUS(status);
}

int main(void)
{
	struct child_args args = { .depth = 1 };
	int status;
	pid_t pid = clone(nested_child, nested_stacks[0] + stack_size, SIGCHLD,
	                  &args);

	if (pid == -1)
		test_perror("outer clone");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid outer clone");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 23)
		test_fail("nested callback clone chain did not preserve exit status");

	printf("nested clone: reached depth=%d; deepest callback exited 23\n",
	       max_depth);
	test_pass();
}
