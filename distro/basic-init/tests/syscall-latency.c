#define _GNU_SOURCE
#include "test.h"

#include <stdint.h>
#include <time.h>
#include <unistd.h>

enum {
	rounds = 5,
	iterations = 1000000,
};

static uint64_t monotonic_nanoseconds(void)
{
	struct timespec now;

	if (clock_gettime(CLOCK_MONOTONIC, &now) == -1)
		test_perror("clock_gettime");
	return (uint64_t)now.tv_sec * 1000000000 + now.tv_nsec;
}

/*
 * Reports the cost of the cheapest syscall, which is dominated by the
 * user-to-kernel transition rather than by the work the kernel does.
 */
int main(void)
{
	pid_t pid = getpid();
	int round;

	for (round = 0; round < rounds; round++) {
		uint64_t before = monotonic_nanoseconds();
		uint64_t elapsed;
		int i;

		for (i = 0; i < iterations; i++)
			if (getpid() != pid)
				test_fail("getpid returned a different pid");
		elapsed = monotonic_nanoseconds() - before;
		printf("syscall latency: round=%d getpid_ns=%llu.%02llu\n", round,
		       (unsigned long long)(elapsed / iterations),
		       (unsigned long long)(elapsed % iterations * 100 / iterations));
	}

	test_pass();
}
