#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <unistd.h>

int main(void)
{
	/* An empty segment first, as musl's stdio flushes an empty buffer. */
	char value[] = "100\n";
	struct iovec iov[] = {
		{ .iov_base = NULL, .iov_len = 0 },
		{ .iov_base = value, .iov_len = sizeof(value) - 1 },
	};
	char buffer[16] = { 0 };
	int fd;

	if (mkdir("/proc", 0555) == -1 && errno != EEXIST)
		test_perror("mkdir /proc");
	if (mount("proc", "/proc", "proc", 0, NULL) == -1 && errno != EBUSY)
		test_perror("mount /proc");

	/* oom_score_adj fails a zero-length write with EINVAL. */
	fd = open("/proc/self/oom_score_adj", O_RDWR);
	if (fd == -1)
		test_perror("open /proc/self/oom_score_adj");
	if (writev(fd, iov, 2) != (ssize_t)(sizeof(value) - 1))
		test_perror("writev /proc/self/oom_score_adj");
	if (pread(fd, buffer, sizeof(buffer) - 1, 0) <= 0)
		test_perror("read /proc/self/oom_score_adj");
	if (strcmp(buffer, value) != 0)
		test_fail("oom_score_adj did not take the written value");
	close(fd);

	test_pass();
}
