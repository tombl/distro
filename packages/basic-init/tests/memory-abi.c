#include "test.h"

#include <unistd.h>

int main(void)
{
	char *const argv[] = { "/bin/module-defined-memory", NULL };

	execv(argv[0], argv);
	if (errno != ENOEXEC)
		test_perror("exec module-defined-memory");

	test_pass();
}
