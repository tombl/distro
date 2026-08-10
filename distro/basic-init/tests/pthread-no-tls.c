#include "test.h"

#include <pthread.h>
#include <stdint.h>

static void *worker(void *argument)
{
	return argument;
}

int main(void)
{
	void *const expected = (void *)(uintptr_t)42;
	pthread_t thread;
	void *result;

	if (__builtin_wasm_tls_size() != 0 || __builtin_wasm_tls_align() != 0)
		test_fail("test binary unexpectedly has thread-local storage");
	if (pthread_create(&thread, NULL, worker, expected) != 0)
		test_fail("pthread_create failed");
	if (pthread_join(thread, &result) != 0)
		test_fail("pthread_join failed");
	if (result != expected)
		test_fail("pthread result was corrupted");

	test_pass();
}
