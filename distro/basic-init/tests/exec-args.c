#include "test.h"

#include <errno.h>
#include <unistd.h>

enum { argument_count = 45000 };

static char *argv[argument_count + 1];

int main(void)
{
	char *envp[] = { NULL };

	for (int i = 0; i < argument_count; i++)
		argv[i] = "x";

	/*
	 * The strings occupy only 90 KiB, but their pointer table pushes the
	 * complete process blob beyond the wasm ABI's 256 KiB limit.
	 */
	errno = 0;
	execve("/init", argv, envp);
	if (errno != E2BIG)
		test_perror("oversized argument blob did not fail with E2BIG");

	test_pass();
}
