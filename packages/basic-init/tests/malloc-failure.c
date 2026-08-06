#define _DEFAULT_SOURCE
#include "test.h"

#include <stdint.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <unistd.h>

enum {
	page_size = 64 * 1024,
	limit_growth_pages = 64,
};

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
	void *before;
	void *after;
	void *allocation;
	size_t allocation_size;

	if (argc != 2 || strcmp(argv[1], "limited") != 0)
		exec_with_memory_limit();
	if (getrlimit(RLIMIT_AS, &limit) == -1)
		test_perror("getrlimit");

	uintptr_t memory_limit = (uintptr_t)limit.rlim_cur;
	uintptr_t current = (uintptr_t)sbrk(0);
	if (current >= memory_limit || memory_limit - current > SIZE_MAX - page_size)
		test_fail("invalid address-space limit");
	allocation_size = memory_limit - current + page_size;

	before = sbrk(0);
	errno = 0;
	allocation = malloc(allocation_size);
	if (allocation != NULL)
		test_fail("low-memory malloc unexpectedly succeeded");
	if (errno != ENOMEM)
		test_fail("failed malloc did not report ENOMEM");
	after = sbrk(0);
	if ((uintptr_t)after - (uintptr_t)before >= allocation_size)
		test_fail("failed malloc leaked its payload allocation");

	test_pass();
}
