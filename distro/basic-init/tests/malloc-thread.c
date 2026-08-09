#include "test.h"

#include <pthread.h>
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

int main(void)
{
	pthread_t thread;
	unsigned char *allocation;
	void *result;

	if (pthread_create(&thread, NULL, worker, NULL) != 0)
		test_fail("pthread_create failed");
	while (!atomic_load(&worker_ready))
		sched_yield();

	allocation = malloc(1);
	if (!allocation)
		test_fail("main malloc failed");
	*allocation = 42;
	if (*allocation != 42)
		test_fail("main allocation was corrupted");
	free(allocation);

	atomic_store(&worker_done, 1);
	if (pthread_join(thread, &result) != 0)
		test_fail("pthread_join failed");
	if (result)
		test_fail(result);

	test_pass();
}
