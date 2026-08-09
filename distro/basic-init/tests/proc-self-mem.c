#include "test.h"

#include <fcntl.h>
#include <stdint.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

static char probe[] = "proc-self-mem-probe";

int main(void)
{
	char result[sizeof(probe)] = { 0 };
	int fd;
	ssize_t length;

	if (mkdir("/proc", 0555) == -1 && errno != EEXIST)
		test_perror("mkdir /proc");
	if (mount("proc", "/proc", "proc", 0, NULL) == -1 && errno != EBUSY)
		test_perror("mount /proc");

	fd = open("/proc/self/mem", O_RDONLY);
	if (fd == -1)
		test_perror("open /proc/self/mem");
	if (lseek(fd, (off_t)(uintptr_t)probe, SEEK_SET) == (off_t)-1)
		test_perror("lseek /proc/self/mem");

	length = read(fd, result, sizeof(result));
	if (length == -1)
		test_perror("read /proc/self/mem");
	if (length != sizeof(probe) || memcmp(result, probe, sizeof(probe)) != 0)
		test_fail("/proc/self/mem returned the wrong data");

	close(fd);
	test_pass();
}
