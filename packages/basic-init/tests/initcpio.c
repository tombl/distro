#include "test.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#define PAYLOAD_SIZE (3 * 1024 * 1024)

static void check_marker(int fd, off_t offset, const char *expected)
{
	char actual[32] = { 0 };
	size_t length = strlen(expected);
	ssize_t read_length;

	read_length = pread(fd, actual, length, offset);
	if (read_length == -1)
		test_perror("reading initcpio payload");
	if (read_length != (ssize_t)length)
		test_fail("initcpio payload was truncated");
	if (memcmp(actual, expected, length) != 0)
		test_fail("initcpio payload was corrupted");
}

int main(void)
{
	struct stat status;
	int fd = open("/payload", O_RDONLY);

	if (fd == -1)
		test_perror("opening initcpio payload");
	if (fstat(fd, &status) == -1)
		test_perror("stating initcpio payload");
	if (status.st_size != PAYLOAD_SIZE)
		test_fail("initcpio payload has the wrong size");

	check_marker(fd, 0, "start-of-payload");
	check_marker(fd, PAYLOAD_SIZE / 2, "middle-of-payload");
	check_marker(fd, PAYLOAD_SIZE - 16, "end-of-payload");
	close(fd);
	test_pass();
}
