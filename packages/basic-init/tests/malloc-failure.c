#define _DEFAULT_SOURCE
#include "test.h"

#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

enum {
	page_size = 64 * 1024,
	large_allocation = 128 * 1024,
	payload_growth = 131104,
};

extern void *__malloc_alloc_meta(void);

int main(void)
{
	size_t first_reserve = 0;
	size_t reserve_interval = 0;
	void *before;
	void *after;

	/* Measure and exhaust one complete allocator metadata reserve. */
	for (size_t i = 1; !reserve_interval; i++) {
		before = sbrk(0);
		if (!__malloc_alloc_meta())
			test_fail("metadata allocation failed during setup");
		after = sbrk(0);
		size_t growth = (uintptr_t)after - (uintptr_t)before;
		if (growth) {
			if (first_reserve)
				reserve_interval = i - first_reserve;
			else {
				first_reserve = i;
			}
		}
	}
	for (size_t i = 1; i < reserve_interval; i++) {
		if (!__malloc_alloc_meta())
			test_fail("metadata allocation failed during exhaustion");
	}

	/* Leave room for the payload, but not the next metadata reserve. */
	uintptr_t memory_limit =
		__builtin_wasm_memory_size(0) * (uintptr_t)page_size;
	uintptr_t current = (uintptr_t)sbrk(0);
	uintptr_t target = memory_limit - payload_growth - page_size;
	while (current < target) {
		intptr_t increment = target - current;
		if (increment > INT32_MAX)
			increment = INT32_MAX;
		if (sbrk(increment) == (void *)-1)
			test_perror("sbrk");
		current += increment;
	}

	before = sbrk(0);
	if (malloc(large_allocation) != NULL)
		test_fail("low-memory malloc unexpectedly succeeded");
	after = sbrk(0);
	if ((uintptr_t)after - (uintptr_t)before >= payload_growth)
		test_fail("failed malloc leaked its payload allocation");

	test_pass();
}
