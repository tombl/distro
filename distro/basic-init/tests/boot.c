#include "test.h"

#include <sys/utsname.h>
#include <unistd.h>

int main(void)
{
	struct utsname system;

	if (getpid() != 1)
		test_fail("init is not pid 1");
	if (uname(&system) == -1)
		test_perror("uname");
	if (strcmp(system.sysname, "Linux") != 0)
		test_fail("uname did not report Linux");

	test_pass();
}
