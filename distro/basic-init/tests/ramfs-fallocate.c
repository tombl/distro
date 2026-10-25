#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <linux/falloc.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/*
 * The kernel takes each system call argument from one slot, so musl's
 * fallocate(), which splits each off_t across two, passes a length of zero.
 * Pass each as one slot until 64-bit arguments have slots of their own.
 */
static int falloc(int fd, int mode, long offset, long len)
{
	return syscall(SYS_fallocate, fd, mode, offset, len);
}

static off_t size_of(int fd)
{
	struct stat st;

	if (fstat(fd, &st) == -1)
		test_perror("fstat");
	return st.st_size;
}

static int create(const char *path)
{
	int fd = open(path, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);

	if (fd == -1)
		test_perror(path);
	return fd;
}

int main(void)
{
	/* Large enough that its pages cannot be allocated contiguously. */
	const off_t large = 128 << 20;
	char buffer[5];
	int fd;

	/* Without an MMU, tmpfs is ramfs. */
	if (mkdir("/tmp", 01777) == -1 && errno != EEXIST)
		test_perror("mkdir /tmp");
	if (mount("tmpfs", "/tmp", "tmpfs", 0, NULL) == -1)
		test_perror("mount /tmp");

	/* Growing a non-empty file sets its size. */
	fd = create("/tmp/small");
	if (pwrite(fd, "hello", 5, 0) != 5)
		test_perror("pwrite");
	if (falloc(fd, 0, 0, 4096) == -1)
		test_perror("fallocate a non-empty file");
	if (size_of(fd) != 4096)
		test_fail("fallocate did not grow a non-empty file");
	if (pread(fd, buffer, 5, 0) != 5)
		test_perror("pread");
	if (memcmp(buffer, "hello", 5) != 0)
		test_fail("fallocate changed a file's data");
	if (falloc(fd, 0, 0, 16) == -1)
		test_perror("fallocate within the file");
	if (size_of(fd) != 4096)
		test_fail("fallocate within the file changed its size");
	if (falloc(fd, FALLOC_FL_KEEP_SIZE, 0, 8192) == -1)
		test_perror("fallocate with FALLOC_FL_KEEP_SIZE");
	if (size_of(fd) != 4096)
		test_fail("FALLOC_FL_KEEP_SIZE changed the size");
	errno = 0;
	if (falloc(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, 0, 16) != -1 ||
	    errno != EOPNOTSUPP)
		test_fail("punching a hole did not fail with EOPNOTSUPP");
	close(fd);

	/* A small empty file is expanded contiguously, as for a shared mapping. */
	fd = create("/tmp/empty");
	if (falloc(fd, 0, 0, 65536) == -1)
		test_perror("fallocate a small empty file");
	if (size_of(fd) != 65536)
		test_fail("fallocate did not grow a small empty file");
	close(fd);

	/* A large empty file falls back to setting the size alone. */
	fd = create("/tmp/large");
	if (falloc(fd, 0, 0, large) == -1)
		test_perror("fallocate a large empty file");
	if (size_of(fd) != large)
		test_fail("fallocate did not grow a large empty file");
	if (pwrite(fd, "end", 3, large - 3) != 3)
		test_perror("pwrite at the end");
	if (pread(fd, buffer, 3, large - 3) != 3)
		test_perror("pread at the end");
	if (memcmp(buffer, "end", 3) != 0)
		test_fail("the end of a large file read back the wrong data");
	if (pread(fd, buffer, 1, 4096) != 1)
		test_perror("pread a hole");
	if (buffer[0] != 0)
		test_fail("a hole did not read as zero");
	close(fd);

	test_pass();
}
