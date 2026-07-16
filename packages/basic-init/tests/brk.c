#define _DEFAULT_SOURCE
#include "test.h"

#include <stdint.h>
#include <unistd.h>

int main(void)
{
	char *start = sbrk(0);
	void *previous;

	if (start == (void *)-1)
		test_perror("sbrk");
	previous = sbrk(1);
	if (previous == (void *)-1)
		test_perror("sbrk");
	if (previous != start)
		test_fail("sbrk did not return the previous break");
	if (sbrk(0) != start + 1)
		test_fail("sbrk rounded the program break");

	test_pass();
}
