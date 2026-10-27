#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

static off_t size_of(int fd)
{
	struct stat st;

	if (fstat(fd, &st) == -1)
		test_perror("fstat");
	return st.st_size;
}

int main(void)
{
	/*
	 * Past MAX_PAGE_ORDER (64 MiB with 64 KiB pages), so its pages cannot
	 * be allocated contiguously.
	 */
	const off_t large = 72 << 20;
	char buffer[3];
	int fd;

	/* Without an MMU, tmpfs is ramfs. */
	if (mkdir("/tmp", 01777) == -1 && errno != EEXIST)
		test_perror("mkdir /tmp");
	if (mount("tmpfs", "/tmp", "tmpfs", 0, NULL) == -1)
		test_perror("mount /tmp");

	fd = open("/tmp/file", O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
	if (fd == -1)
		test_perror("open /tmp/file");

	/*
	 * Truncating an empty file up allocated all of its pages contiguously,
	 * for a shared mapping that wasm cannot make, so this failed with
	 * EFBIG.
	 */
	if (ftruncate(fd, large) == -1)
		test_perror("ftruncate an empty file past 64 MiB");
	if (size_of(fd) != large)
		test_fail("ftruncate did not grow an empty file");
	if (pwrite(fd, "end", 3, large - 3) != 3)
		test_perror("pwrite at the end");
	if (pread(fd, buffer, 3, large - 3) != 3)
		test_perror("pread at the end");
	if (memcmp(buffer, "end", 3) != 0)
		test_fail("the end of the file read back the wrong data");
	if (pread(fd, buffer, 1, large / 2) != 1)
		test_perror("pread the middle");
	if (buffer[0] != 0)
		test_fail("the middle of the file did not read as zero");

	/* Shrinking and growing again keeps the data below the new size. */
	if (ftruncate(fd, 2) == -1)
		test_perror("ftruncate down");
	if (pwrite(fd, "ab", 2, 0) != 2)
		test_perror("pwrite at the start");
	if (ftruncate(fd, 1 << 20) == -1)
		test_perror("ftruncate up");
	if (pread(fd, buffer, 3, 0) != 3)
		test_perror("pread at the start");
	if (memcmp(buffer, "ab\0", 3) != 0)
		test_fail("growing a file changed its data");
	close(fd);

	test_pass();
}
