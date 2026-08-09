#include "test.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>

static _Thread_local int tls_value = 41;
static _Atomic int child_tls_value = -1;
static _Atomic uintptr_t child_thread;

static void *worker(void *unused)
{
	(void)unused;
	atomic_store(&child_thread, (uintptr_t)pthread_self());
	atomic_store(&child_tls_value, tls_value);

	for (;;)
		sched_yield();
}

int main(void)
{
	char message[80];
	pthread_t thread;
	int child_value;

	tls_value = 40;
	if (pthread_create(&thread, NULL, worker, NULL) != 0)
		test_fail("pthread_create failed");

	do {
		child_value = atomic_load(&child_tls_value);
		sched_yield();
	} while (child_value == -1);

	if (child_value != 41) {
		snprintf(message, sizeof(message),
			 "thread-local storage was not initialized: got %d, want 41",
			 child_value);
		test_fail(message);
	}
	if (atomic_load(&child_thread) != (uintptr_t)thread)
		test_fail("pthread thread pointer was not installed");
	if (tls_value != 40)
		test_fail("thread-local storage was shared");

	test_pass();
}
