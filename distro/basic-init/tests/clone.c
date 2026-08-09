#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static int child_ran;

static int child(void *unused)
{
	(void)unused;
	child_ran = 1;
	_exit(0);
}

int main(void)
{
	const size_t stack_size = 64 * 1024;
	char *stack = malloc(stack_size);
	int status;
	pid_t pid;

	if (!stack)
		test_perror("malloc");

	pid = clone(child, stack + stack_size,
		    CLONE_VM | CLONE_VFORK | SIGCHLD, NULL);
	if (pid == -1)
		test_perror("clone");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("clone child did not exit successfully");
	if (!child_ran)
		test_fail("clone child did not share memory");

	free(stack);
	test_pass();
}
