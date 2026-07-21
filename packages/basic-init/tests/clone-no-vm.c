#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static int global_value = 11;

struct child_args {
	int ready_fd;
	int continue_fd;
	int stack_value;
	int *heap_value;
};

static int child(void *opaque)
{
	struct child_args *args = opaque;
	char byte = 1;

	if (global_value != 11 || *args->heap_value != 22 ||
	    args->stack_value != 33)
		return 1;

	global_value = 101;
	*args->heap_value = 102;
	args->stack_value = 103;
	if (write(args->ready_fd, &byte, sizeof(byte)) != sizeof(byte))
		return 2;
	if (read(args->continue_fd, &byte, sizeof(byte)) != sizeof(byte))
		return 3;

	if (global_value != 101 || *args->heap_value != 102 ||
	    args->stack_value != 103)
		return 4;

	return 0;
}

int main(void)
{
	const size_t stack_size = 64 * 1024;
	char *stack = malloc(stack_size);
	int *heap_value = malloc(sizeof(*heap_value));
	int ready_pipe[2];
	int continue_pipe[2];
	struct child_args args;
	char byte;
	int status;
	pid_t pid;

	if (!stack || !heap_value)
		test_perror("malloc");
	if (pipe(ready_pipe) == -1 || pipe(continue_pipe) == -1)
		test_perror("pipe");

	*heap_value = 22;
	args = (struct child_args) {
		.ready_fd = ready_pipe[1],
		.continue_fd = continue_pipe[0],
		.stack_value = 33,
		.heap_value = heap_value,
	};

	pid = clone(child, stack + stack_size, SIGCHLD, &args);
	if (pid == -1)
		test_perror("clone without CLONE_VM");
	if (read(ready_pipe[0], &byte, sizeof(byte)) != sizeof(byte))
		test_perror("read child readiness");
	if (global_value != 11 || *heap_value != 22 || args.stack_value != 33)
		test_fail("clone child modified parent memory");

	global_value = 201;
	*heap_value = 202;
	args.stack_value = 203;
	if (write(continue_pipe[1], &byte, sizeof(byte)) != sizeof(byte))
		test_perror("continue child");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("clone child did not retain its private memory");

	free(heap_value);
	free(stack);
	test_pass();
}
