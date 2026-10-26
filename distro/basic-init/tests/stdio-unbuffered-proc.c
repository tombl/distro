#define _GNU_SOURCE
#include "test.h"

#include <sys/mount.h>
#include <sys/stat.h>

int main(void)
{
	char buffer[16] = { 0 };
	FILE *file;

	if (mkdir("/proc", 0555) == -1 && errno != EEXIST)
		test_perror("mkdir /proc");
	if (mount("proc", "/proc", "proc", 0, NULL) == -1 && errno != EBUSY)
		test_perror("mount /proc");

	/*
	 * An unbuffered stream's buffer is always empty. musl used to send it
	 * to writev as an empty first segment, which oom_score_adj, like other
	 * proc files with a .write handler, fails with EINVAL.
	 */
	file = fopen("/proc/self/oom_score_adj", "w");
	if (!file)
		test_perror("fopen /proc/self/oom_score_adj");
	if (setvbuf(file, NULL, _IONBF, 0) != 0)
		test_fail("setvbuf failed");
	if (fputs("100\n", file) == EOF)
		test_perror("fputs /proc/self/oom_score_adj");
	if (fclose(file) == EOF)
		test_perror("fclose /proc/self/oom_score_adj");

	file = fopen("/proc/self/oom_score_adj", "r");
	if (!file)
		test_perror("fopen /proc/self/oom_score_adj");
	if (!fgets(buffer, sizeof(buffer), file))
		test_perror("read /proc/self/oom_score_adj");
	fclose(file);
	if (strcmp(buffer, "100\n") != 0)
		test_fail("oom_score_adj did not take the written value");

	test_pass();
}
