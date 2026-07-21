#include "test.h"

#include <stdint.h>
#include <time.h>

enum {
	jan_1_2025 = 1735689600,
	jan_1_2100 = 4102444800,
};

int main(void)
{
	struct timespec realtime;

	if (clock_gettime(CLOCK_REALTIME, &realtime) == -1)
		test_perror("clock_gettime(CLOCK_REALTIME)");
	if (realtime.tv_sec < jan_1_2025 || realtime.tv_sec >= jan_1_2100)
		test_fail("CLOCK_REALTIME is outside the expected wall-clock range");

	test_pass();
}
