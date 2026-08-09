#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdlib.h>

static int child(void *unused)
{
	(void)unused;
	return 0;
}

int main(void)
{
	const size_t stack_size = 64 * 1024;
	char *stack = malloc(stack_size);

	if (!stack)
		test_perror("malloc");
	if (clone(child, stack + stack_size,
		  CLONE_VM | CLONE_VFORK | SIGCHLD, NULL) == -1)
		test_perror("clone");

	free(stack);
	test_pass();
}
