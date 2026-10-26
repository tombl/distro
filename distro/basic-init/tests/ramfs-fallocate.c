#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <linux/falloc.h>
#include <signal.h>
#include <sys/resource.h>
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

static int create(const char *path)
{
	int fd = open(path, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);

	if (fd == -1)
		test_perror(path);
	return fd;
}

int main(void)
{
	/*
	 * Past MAX_PAGE_ORDER (64 MiB with 64 KiB pages), so its pages cannot
	 * be allocated contiguously.
	 */
	const off_t large = 72 << 20;
	struct rlimit limit;
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
	if (fallocate(fd, 0, 0, 4096) == -1)
		test_perror("fallocate a non-empty file");
	if (size_of(fd) != 4096)
		test_fail("fallocate did not grow a non-empty file");
	if (pread(fd, buffer, 5, 0) != 5)
		test_perror("pread");
	if (memcmp(buffer, "hello", 5) != 0)
		test_fail("fallocate changed a file's data");
	if (fallocate(fd, 0, 0, 16) == -1)
		test_perror("fallocate within the file");
	if (size_of(fd) != 4096)
		test_fail("fallocate within the file changed its size");
	if (fallocate(fd, FALLOC_FL_KEEP_SIZE, 0, 4096) == -1)
		test_perror("fallocate with FALLOC_FL_KEEP_SIZE");
	if (size_of(fd) != 4096)
		test_fail("FALLOC_FL_KEEP_SIZE changed the size");
	/* Pages beyond the size would be in the way of a shared mapping. */
	errno = 0;
	if (fallocate(fd, FALLOC_FL_KEEP_SIZE, 0, 8192) != -1 || errno != EOPNOTSUPP)
		test_fail("FALLOC_FL_KEEP_SIZE beyond the size did not fail with EOPNOTSUPP");
	if (size_of(fd) != 4096)
		test_fail("a failed FALLOC_FL_KEEP_SIZE changed the size");
	errno = 0;
	if (fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, 0, 16) != -1 ||
	    errno != EOPNOTSUPP)
		test_fail("punching a hole did not fail with EOPNOTSUPP");
	close(fd);

	/* RLIMIT_FSIZE applies, as it does to a write. */
	if (getrlimit(RLIMIT_FSIZE, &limit) == -1)
		test_perror("getrlimit");
	signal(SIGXFSZ, SIG_IGN);
	fd = create("/tmp/limited");
	if (setrlimit(RLIMIT_FSIZE, &(struct rlimit){ 65536, limit.rlim_max }) == -1)
		test_perror("setrlimit");
	errno = 0;
	if (fallocate(fd, 0, 0, 131072) != -1 || errno != EFBIG)
		test_fail("fallocate past RLIMIT_FSIZE did not fail with EFBIG");
	if (setrlimit(RLIMIT_FSIZE, &limit) == -1)
		test_perror("setrlimit");
	signal(SIGXFSZ, SIG_DFL);
	if (size_of(fd) != 0)
		test_fail("fallocate past RLIMIT_FSIZE changed the size");
	close(fd);

	/* An empty file grows. */
	fd = create("/tmp/empty");
	if (fallocate(fd, 0, 0, 65536) == -1)
		test_perror("fallocate a small empty file");
	if (size_of(fd) != 65536)
		test_fail("fallocate did not grow a small empty file");
	close(fd);

	/* So does one too large to expand contiguously. */
	fd = create("/tmp/large");
	if (fallocate(fd, 0, 0, large) == -1)
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
		test_perror("pread an allocated page");
	if (buffer[0] != 0)
		test_fail("an allocated page did not read as zero");
	close(fd);

	test_pass();
}
