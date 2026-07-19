#define _DEFAULT_SOURCE
#include "test.h"

#include <stdint.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <unistd.h>

enum {
	page_size = 64 * 1024,
	limit_growth_pages = 64,
	large_allocation = 128 * 1024,
	payload_growth = 131104,
};

extern void *__malloc_alloc_meta(void);

static void exec_with_memory_limit(void)
{
	struct rlimit limit;
	char *argv[] = { "/init", "limited", NULL };

	if (getrlimit(RLIMIT_AS, &limit) == -1)
		test_perror("getrlimit");
	limit.rlim_cur = (__builtin_wasm_memory_size(0) + limit_growth_pages) *
			 (rlim_t)page_size;
	if (setrlimit(RLIMIT_AS, &limit) == -1)
		test_perror("setrlimit");
	execv("/init", argv);
	test_perror("execv");
}

int main(int argc, char **argv)
{
	struct rlimit limit;
	size_t first_reserve = 0;
	size_t reserve_interval = 0;
	void *before;
	void *after;
	void *allocation;

	if (argc != 2 || strcmp(argv[1], "limited") != 0)
		exec_with_memory_limit();
	if (getrlimit(RLIMIT_AS, &limit) == -1)
		test_perror("getrlimit");

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
	uintptr_t memory_limit = (uintptr_t)limit.rlim_cur;
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
	errno = 0;
	allocation = malloc(large_allocation);
	if (allocation != NULL)
		test_fail("low-memory malloc unexpectedly succeeded");
	if (errno != ENOMEM)
		test_fail("failed malloc did not report ENOMEM");
	after = sbrk(0);
	if ((uintptr_t)after - (uintptr_t)before >= payload_growth)
		test_fail("failed malloc leaked its payload allocation");

	test_pass();
}
