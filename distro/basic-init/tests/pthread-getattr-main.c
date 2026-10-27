#define _GNU_SOURCE
#include "test.h"

#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/wait.h>

/*
 * A child cloned without CLONE_VM keeps the main thread's descriptor but runs
 * on the stack it was given, so the linker's bounds do not describe it.
 */
static int cloned(void *unused)
{
	pthread_attr_t attr;

	(void)unused;
	return pthread_getattr_np(pthread_self(), &attr) == ENOSYS ? 0 : 1;
}

int main(void)
{
	const size_t child_stack_size = 64 * 1024;
	char *child_stack;
	int status;
	pid_t pid;
	pthread_attr_t attr;
	volatile char local = 0;
	uintptr_t here = (uintptr_t)&local;
	void *address;
	size_t size;

	/* The main thread has no stack of musl's own, which used to crash. */
	if (pthread_getattr_np(pthread_self(), &attr) != 0)
		test_fail("pthread_getattr_np failed");
	if (pthread_attr_getstack(&attr, &address, &size) != 0)
		test_fail("pthread_attr_getstack failed");
	pthread_attr_destroy(&attr);

	/* The platform links with -z stack-size=8388608. */
	if (size != 8 << 20)
		test_fail("the main thread's stack is not 8 MiB");
	if (here < (uintptr_t)address || here >= (uintptr_t)address + size)
		test_fail("the main thread's stack does not hold a local variable");

	child_stack = malloc(child_stack_size);
	if (!child_stack)
		test_perror("malloc");
	pid = clone(cloned, child_stack + child_stack_size, SIGCHLD, NULL);
	if (pid == -1)
		test_perror("clone without CLONE_VM");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status))
		test_fail("a cloned child's pthread_getattr_np did not fail with ENOSYS");
	free(child_stack);

	test_pass();
}
