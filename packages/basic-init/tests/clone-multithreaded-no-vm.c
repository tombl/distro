#define _GNU_SOURCE
#include "test.h"

#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdlib.h>

static _Atomic int worker_ready;
static _Atomic int worker_done;

static void *worker(void *unused)
{
	(void)unused;
	atomic_store(&worker_ready, 1);
	while (!atomic_load(&worker_done))
		sched_yield();
	return NULL;
}

static int child(void *unused)
{
	(void)unused;
	return 0;
}

int main(void)
{
	const size_t stack_size = 64 * 1024;
	char *stack = malloc(stack_size);
	pthread_t thread;
	void *result;

	if (!stack)
		test_perror("malloc");
	if (pthread_create(&thread, NULL, worker, NULL) != 0)
		test_fail("pthread_create failed");
	while (!atomic_load(&worker_ready))
		sched_yield();

	errno = 0;
	if (clone(child, stack + stack_size, SIGCHLD, NULL) != -1)
		test_fail("private clone from a multithreaded process succeeded");
	if (errno != EOPNOTSUPP)
		test_perror("private clone from a multithreaded process");

	atomic_store(&worker_done, 1);
	if (pthread_join(thread, &result) != 0)
		test_fail("pthread_join failed");
	if (result)
		test_fail(result);

	free(stack);
	test_pass();
}
