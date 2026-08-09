#include "test.h"

#include <pthread.h>
#include <stdint.h>

static _Thread_local int tls_value = 41;

static void *worker(void *unused)
{
	(void)unused;
	if (tls_value != 41)
		return (void *)(uintptr_t)1;

	tls_value = 42;
	return NULL;
}

int main(void)
{
	pthread_t thread;
	void *result;

	tls_value = 40;
	if (pthread_create(&thread, NULL, worker, NULL) != 0)
		test_fail("pthread_create failed");
	if (pthread_join(thread, &result) != 0)
		test_fail("pthread_join failed");
	if (result != NULL)
		test_fail("thread-local storage was not initialized");
	if (tls_value != 40)
		test_fail("thread-local storage was shared");

	test_pass();
}
