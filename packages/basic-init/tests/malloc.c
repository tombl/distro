#include "test.h"

#include <stdint.h>
#include <stdlib.h>

enum {
	allocation_count = 120000,
};

int main(void)
{
	unsigned char **allocations = malloc(sizeof(*allocations) * allocation_count);

	if (!allocations)
		test_perror("malloc pointer table");

	for (size_t i = 0; i < allocation_count; i++) {
		allocations[i] = malloc(1);
		if (!allocations[i])
			test_perror("malloc");
		allocations[i][0] = (unsigned char)i;
	}

	for (size_t i = 0; i < allocation_count; i++) {
		if (allocations[i][0] != (unsigned char)i)
			test_fail("malloc allocations overlapped");
	}

	for (size_t i = 0; i < allocation_count; i++)
		free(allocations[i]);
	free(allocations);

	test_pass();
}
