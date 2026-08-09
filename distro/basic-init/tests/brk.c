#define _DEFAULT_SOURCE
#include "test.h"

#include <stdint.h>
#include <unistd.h>

int main(void)
{
	char message[96];
	char *start = sbrk(0);
	char *end;
	void *previous;

	if (start == (void *)-1)
		test_perror("sbrk");
	previous = sbrk(1);
	if (previous == (void *)-1)
		test_perror("sbrk");
	if (previous != start)
		test_fail("sbrk did not return the previous break");
	end = sbrk(0);
	if (end != start + 1) {
		snprintf(message, sizeof(message),
			 "sbrk rounded the program break: got %p, want %p",
			 end, start + 1);
		test_fail(message);
	}

	test_pass();
}
