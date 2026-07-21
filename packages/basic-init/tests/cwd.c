#define _GNU_SOURCE
#include "test.h"

#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

int main(void)
{
	char *cwd;

	if (mkdir("/directory", 0755) == -1 && errno != EEXIST)
		test_perror("mkdir");
	if (chdir("/directory") == -1)
		test_perror("chdir");

	cwd = getcwd(NULL, 0);
	if (!cwd)
		test_perror("getcwd");
	if (strcmp(cwd, "/directory") != 0)
		test_fail("getcwd returned the wrong directory");

	free(cwd);
	test_pass();
}
