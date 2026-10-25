#define _GNU_SOURCE
#include "test.h"

#include <pthread.h>
#include <stdint.h>

int main(void)
{
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

	test_pass();
}
