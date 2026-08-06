#include "test.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

enum {
	allocation_count = 128,
	stress_rounds = 4000,
};

static _Atomic int phase;
static unsigned char *worker_allocations[allocation_count];
static unsigned char *main_allocations[allocation_count];

static const char *stress_allocations(unsigned char seed)
{
	for (size_t i = 0; i < stress_rounds; i++) {
		size_t size = 1 + (i * 37 % 4096);
		unsigned char *p = malloc(size);
		if (!p)
			return "concurrent malloc failed";
		memset(p, seed, size);
		for (size_t j = 0; j < size; j++)
			if (p[j] != seed)
				return "concurrent allocation was corrupted";
		free(p);
	}
	return NULL;
}

static void *worker(void *unused)
{
	(void)unused;
	const char *error = stress_allocations(0xa5);
	if (error)
		return (void *)error;

	for (size_t i = 0; i < allocation_count; i++) {
		worker_allocations[i] = malloc(1024 + i);
		if (!worker_allocations[i])
			return "worker handoff malloc failed";
		memset(worker_allocations[i], (unsigned char)i, 1024 + i);
	}
	atomic_store(&phase, 1);
	while (atomic_load(&phase) != 2)
		sched_yield();

	for (size_t i = 0; i < allocation_count; i++) {
		for (size_t j = 0; j < 2048 + i; j++)
			if (main_allocations[i][j] != (unsigned char)(i + 1))
				return "main allocation was corrupted before worker free";
		free(main_allocations[i]);
	}
	return NULL;
}

int main(void)
{
	pthread_t thread;
	void *result;

	if (pthread_create(&thread, NULL, worker, NULL) != 0)
		test_fail("pthread_create failed");
	const char *error = stress_allocations(0x5a);
	if (error)
		test_fail(error);
	while (atomic_load(&phase) != 1)
		sched_yield();

	for (size_t i = 0; i < allocation_count; i++) {
		for (size_t j = 0; j < 1024 + i; j++)
			if (worker_allocations[i][j] != (unsigned char)i)
				test_fail("worker allocation was corrupted before main free");
		free(worker_allocations[i]);

		main_allocations[i] = malloc(2048 + i);
		if (!main_allocations[i])
			test_fail("main handoff malloc failed");
		memset(main_allocations[i], (unsigned char)(i + 1), 2048 + i);
	}

	atomic_store(&phase, 2);
	if (pthread_join(thread, &result) != 0)
		test_fail("pthread_join failed");
	if (result)
		test_fail(result);

	test_pass();
}
