#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum {
	page_size = 64 * 1024,
	stack_size = 64 * 1024,
};

struct child_args {
	size_t pages;
};

static uint64_t monotonic_nanoseconds(void)
{
	struct timespec now;

	if (clock_gettime(CLOCK_MONOTONIC, &now) == -1)
		test_perror("clock_gettime");
	return (uint64_t)now.tv_sec * 1000000000 + now.tv_nsec;
}

static int child(void *opaque)
{
	struct child_args *args = opaque;

	if (__builtin_wasm_memory_size(0) != args->pages)
		return 1;
	return 0;
}

int main(void)
{
	static const size_t growth_pages[] = { 0, 128, 512, 1024 };
	char *stack = malloc(stack_size);
	size_t initial_pages = __builtin_wasm_memory_size(0);
	size_t i;

	if (!stack)
		test_perror("malloc");
	for (i = 0; i < sizeof(growth_pages) / sizeof(growth_pages[0]); i++) {
		struct child_args args;
		size_t target = initial_pages + growth_pages[i];
		uint64_t before;
		uint64_t cloned;
		uint64_t reaped;
		volatile unsigned char *last;
		int status;
		pid_t pid;

		if (__builtin_wasm_memory_size(0) < target &&
		    __builtin_wasm_memory_grow(
			    0, target - __builtin_wasm_memory_size(0)) == SIZE_MAX)
			test_fail("growing linear memory for clone latency");
		last = (void *)(target * (size_t)page_size - 1);
		*last = (unsigned char)i;
		args.pages = target;
		before = monotonic_nanoseconds();
		pid = clone(child, stack + stack_size, SIGCHLD, &args);
		cloned = monotonic_nanoseconds();
		if (pid == -1)
			test_perror("latency clone");
		if (waitpid(pid, &status, 0) == -1)
			test_perror("waitpid");
		reaped = monotonic_nanoseconds();
		if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
			test_fail("latency clone child observed wrong memory size");
		printf("clone latency: pages=%zu bytes=%zu syscall_us=%llu total_us=%llu\n",
		       target, target * (size_t)page_size,
		       (unsigned long long)((cloned - before) / 1000),
		       (unsigned long long)((reaped - before) / 1000));
	}

	free(stack);
	test_pass();
}
