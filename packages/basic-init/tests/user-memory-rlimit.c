#include "test.h"

#include <stdint.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <unistd.h>

enum {
	page_size = 64 * 1024,
	limit_growth_pages = 4,
};

static void set_address_limit(rlim_t bytes)
{
	struct rlimit limit;

	if (getrlimit(RLIMIT_AS, &limit) == -1)
		test_perror("getrlimit");
	limit.rlim_cur = bytes;
	if (setrlimit(RLIMIT_AS, &limit) == -1)
		test_perror("setrlimit");
}

static _Noreturn void run_bounded_child(size_t maximum_pages)
{
	size_t initial_pages = __builtin_wasm_memory_size(0);
	size_t growth;
	size_t previous;
	volatile unsigned char *last;

	if (initial_pages >= maximum_pages)
		test_fail("bounded exec did not start at the module minimum");
	growth = maximum_pages - initial_pages;
	previous = __builtin_wasm_memory_grow(0, growth);
	if (previous != initial_pages)
		test_fail("raw memory growth did not reach RLIMIT_AS");
	if (__builtin_wasm_memory_size(0) != maximum_pages)
		test_fail("user memory has the wrong size at RLIMIT_AS");

	last = (void *)(maximum_pages * (size_t)page_size - 1);
	*last = 0x5a;
	if (*last != 0x5a)
		test_fail("grown user memory was not writable");
	if (__builtin_wasm_memory_grow(0, 1) != SIZE_MAX)
		test_fail("raw memory growth exceeded RLIMIT_AS");
	test_pass();
}

int main(int argc, char **argv)
{
	size_t initial_pages = __builtin_wasm_memory_size(0);
	struct rlimit original;
	char maximum[32];
	char *bounded_argv[] = { "/init", "bounded", maximum, NULL };
	size_t maximum_pages;

	if (argc == 3 && strcmp(argv[1], "bounded") == 0) {
		maximum_pages = strtoul(argv[2], NULL, 10);
		if (!maximum_pages)
			test_fail("invalid bounded exec page limit");
		run_bounded_child(maximum_pages);
	}

	if (getrlimit(RLIMIT_AS, &original) == -1)
		test_perror("getrlimit");
	if (initial_pages < 2)
		test_fail("module minimum is unexpectedly small");

	set_address_limit((initial_pages - 1) * (rlim_t)page_size + page_size - 1);
	errno = 0;
	execv("/init", argv);
	if (errno != ENOMEM)
		test_perror("exec below module minimum");
	if (__builtin_wasm_memory_size(0) != initial_pages)
		test_fail("failed exec replaced the caller's user memory");
	set_address_limit(original.rlim_cur);

	maximum_pages = initial_pages + limit_growth_pages;
	snprintf(maximum, sizeof(maximum), "%zu", maximum_pages);
	set_address_limit(maximum_pages * (rlim_t)page_size + page_size - 1);
	execv("/init", bounded_argv);
	test_perror("bounded exec");
}
