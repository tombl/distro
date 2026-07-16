#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static _Thread_local int tls_value = 41;
static int child_tls_value;

static int child(void *unused)
{
	(void)unused;
	child_tls_value = tls_value;
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

	tls_value = 40;
	pid = clone(child, stack + stack_size,
		    CLONE_VM | CLONE_VFORK | SIGCHLD, NULL);
	if (pid == -1)
		test_perror("clone");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("clone child did not exit successfully");
	if (child_tls_value != 40)
		test_fail("clone child did not inherit thread-local storage");

	free(stack);
	test_pass();
}
