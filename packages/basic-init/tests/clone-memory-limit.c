#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

enum {
	page_size = 64 * 1024,
	limit_growth_pages = 32,
	stack_size = 64 * 1024,
};

static int global_value = 17;

struct child_args {
	size_t current_pages;
	size_t maximum_pages;
	unsigned char *heap;
};

static int child(void *opaque)
{
	struct child_args *args = opaque;
	size_t growth = args->maximum_pages - args->current_pages;
	volatile unsigned char *last;

	if (__builtin_wasm_memory_size(0) != args->current_pages)
		return 1;
	if (global_value != 17 || args->heap[0] != 0x5a ||
	    args->heap[4095] != 0xa5)
		return 2;
	if (__builtin_wasm_memory_grow(0, growth) != args->current_pages)
		return 3;
	if (__builtin_wasm_memory_size(0) != args->maximum_pages)
		return 4;
	last = (void *)(args->maximum_pages * (size_t)page_size - 1);
	*last = 0x73;
	if (__builtin_wasm_memory_grow(0, 1) != SIZE_MAX)
		return 5;

	global_value = 91;
	args->heap[0] = 0x91;
	return 0;
}

static void set_address_limit(size_t maximum_pages)
{
	struct rlimit limit;

	if (getrlimit(RLIMIT_AS, &limit) == -1)
		test_perror("getrlimit");
	limit.rlim_cur = maximum_pages * (rlim_t)page_size;
	if (setrlimit(RLIMIT_AS, &limit) == -1)
		test_perror("setrlimit");
}

int main(int argc, char **argv)
{
	char maximum[32];
	char *bounded_argv[] = { "/init", "bounded", maximum, NULL };
	size_t maximum_pages;
	unsigned char *stack;
	unsigned char *heap;
	struct child_args args;
	size_t growth;
	int status;
	pid_t pid;

	if (argc != 3 || strcmp(argv[1], "bounded") != 0) {
		maximum_pages = __builtin_wasm_memory_size(0) +
				limit_growth_pages;
		snprintf(maximum, sizeof(maximum), "%zu", maximum_pages);
		set_address_limit(maximum_pages);
		execv("/init", bounded_argv);
		test_perror("bounded exec");
	}

	stack = malloc(stack_size);
	heap = malloc(4096);
	if (!stack || !heap)
		test_perror("malloc");
	heap[0] = 0x5a;
	heap[4095] = 0xa5;

	maximum_pages = strtoul(argv[2], NULL, 10);
	if (!maximum_pages)
		test_fail("invalid bounded exec page limit");
	{
		struct rlimit limit;

		if (getrlimit(RLIMIT_AS, &limit) == -1)
			test_perror("getrlimit");
		if (limit.rlim_cur / page_size != maximum_pages)
			test_fail("exec observed the wrong RLIMIT_AS");
	}
	if (maximum_pages <= __builtin_wasm_memory_size(0) + 2)
		test_fail("bounded exec left too little clone growth room");

	growth = maximum_pages - 2 - __builtin_wasm_memory_size(0);
	if (__builtin_wasm_memory_grow(0, growth) == SIZE_MAX)
		test_fail("preparing parent user memory");
	args = (struct child_args) {
		.current_pages = __builtin_wasm_memory_size(0),
		.maximum_pages = maximum_pages,
		.heap = heap,
	};

	pid = clone(child, stack + stack_size, SIGCHLD, &args);
	if (pid == -1)
		test_perror("private clone");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("clone child did not inherit its memory maximum");

	if (__builtin_wasm_memory_size(0) != args.current_pages)
		test_fail("clone child grew parent user memory");
	if (global_value != 17 || heap[0] != 0x5a || heap[4095] != 0xa5)
		test_fail("clone child modified parent user memory");
	if (__builtin_wasm_memory_grow(0, maximum_pages - args.current_pages) !=
	    args.current_pages)
		test_fail("parent did not retain its memory maximum");
	if (__builtin_wasm_memory_grow(0, 1) != SIZE_MAX)
		test_fail("parent exceeded its memory maximum");

	free(heap);
	free(stack);
	test_pass();
}
