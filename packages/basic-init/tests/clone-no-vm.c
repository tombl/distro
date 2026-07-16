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
	if (clone(child, stack + stack_size, SIGCHLD, NULL) != -1)
		test_fail("clone without CLONE_VM succeeded");
	if (errno != EINVAL)
		test_perror("clone without CLONE_VM");

	free(stack);
	test_pass();
}
