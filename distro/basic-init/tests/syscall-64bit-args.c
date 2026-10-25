#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <stdint.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/*
 * On wasm32 each syscall argument is a 32-bit slot, and a loff_t or u64
 * spans two consecutive slots, low word first. Offsets above 4 GiB tell a
 * lost high word apart from the right answer, and the probes for EINVAL catch
 * an argument read from the wrong slot.
 */

#define GIB (1LL << 30)

enum {
	page_size = 64 * 1024,
};

/*
 * Returns a buffer at or above 2 GiB, where a pointer has its sign bit set.
 * Nothing else allocates in the pages grown here.
 */
static char *high_buffer(void)
{
	size_t pages = (size_t)(2 * GIB / page_size) + 1;
	size_t current = __builtin_wasm_memory_size(0);

	if (current < pages &&
	    __builtin_wasm_memory_grow(0, pages - current) == SIZE_MAX)
		test_fail("growing linear memory past 2 GiB");
	return (char *)(uintptr_t)((__builtin_wasm_memory_size(0) - 1) * page_size);
}

static const char path[] = "/syscall-64bit-args.tmp";

static void expect_size(int fd, off_t size, const char *operation)
{
	struct stat st;
	char message[128];

	if (fstat(fd, &st) == -1)
		test_perror("fstat");
	if (st.st_size != size) {
		snprintf(message, sizeof(message), "%s: size %lld, expected %lld",
			 operation, (long long)st.st_size, (long long)size);
		test_fail(message);
	}
}

static void expect_error(int ret, int error, const char *operation)
{
	char message[128];

	if (ret != -1 || errno != error) {
		snprintf(message, sizeof(message), "%s: returned %d (%s), expected %s",
			 operation, ret, ret == -1 ? strerror(errno) : "success",
			 strerror(error));
		test_fail(message);
	}
}

int main(void)
{
	static const char data[] = "above four gibibytes";
	char buffer[sizeof(data)];
	char *high_pointer;
	off_t high = 5 * GIB + 123;
	struct stat st;
	int fd;
	int ret;

	/* AT_FDCWD is a negative int. */
	fd = openat(AT_FDCWD, path, O_RDWR | O_CREAT | O_TRUNC, 0600);
	if (fd == -1)
		test_perror("openat(AT_FDCWD)");
	if (fstatat(AT_FDCWD, path, &st, 0) == -1)
		test_perror("fstatat(AT_FDCWD)");

	ret = syscall(SYS_faccessat, AT_FDCWD, path, R_OK | W_OK, 0);
	if (ret == -1)
		test_perror("syscall(SYS_faccessat, AT_FDCWD)");

	if (ftruncate(fd, 5 * GIB) == -1)
		test_perror("ftruncate past 4 GiB");
	expect_size(fd, 5 * GIB, "ftruncate past 4 GiB");
	if (truncate(path, 5 * GIB + 1) == -1)
		test_perror("truncate past 4 GiB");
	expect_size(fd, 5 * GIB + 1, "truncate past 4 GiB");
	/* A negative length has its high word set. */
	expect_error(ftruncate(fd, -1), EINVAL, "ftruncate to a negative length");
	expect_error(ftruncate(fd, -5 * GIB), EINVAL,
		     "ftruncate to a negative length below -4 GiB");

	if (pwrite(fd, data, sizeof(data), high) != sizeof(data))
		test_perror("pwrite above 4 GiB");
	expect_size(fd, high + sizeof(data), "pwrite above 4 GiB");
	if (pread(fd, buffer, sizeof(buffer), high) != sizeof(buffer))
		test_perror("pread above 4 GiB");
	if (memcmp(buffer, data, sizeof(data)) != 0)
		test_fail("pread above 4 GiB returned different bytes");
	/* The same low word below 4 GiB is still a hole. */
	if (pread(fd, buffer, sizeof(buffer), (off_t)(uint32_t)high) !=
	    sizeof(buffer))
		test_perror("pread below 4 GiB");
	if (memcmp(buffer, (char[sizeof(data)]){ 0 }, sizeof(data)) != 0)
		test_fail("pwrite above 4 GiB also wrote below 4 GiB");
	expect_error(pread(fd, buffer, 1, -1), EINVAL, "pread at a negative offset");

	/* Pointers at or above 2 GiB. */
	high_pointer = high_buffer();
	if ((uintptr_t)high_pointer < 2 * GIB)
		test_fail("high buffer is below 2 GiB");
	if (pread(fd, high_pointer, sizeof(data), high) != sizeof(data))
		test_perror("pread into a buffer above 2 GiB");
	if (memcmp(high_pointer, data, sizeof(data)) != 0)
		test_fail("pread into a buffer above 2 GiB returned different bytes");
	memset(high_pointer, 0, sizeof(data));
	if (lseek(fd, high, SEEK_SET) != high)
		test_perror("lseek(SEEK_SET) above 4 GiB");
	if (read(fd, high_pointer, sizeof(data)) != sizeof(data))
		test_perror("read into a buffer above 2 GiB");
	if (memcmp(high_pointer, data, sizeof(data)) != 0)
		test_fail("read into a buffer above 2 GiB returned different bytes");
	memcpy(high_pointer, "high", 4);
	if (pwrite(fd, high_pointer, 4, high) != 4)
		test_perror("pwrite from a buffer above 2 GiB");
	if (pread(fd, buffer, 4, high) != 4 || memcmp(buffer, "high", 4) != 0)
		test_fail("pwrite from a buffer above 2 GiB wrote different bytes");
	/* syscall() passes longs, so the caller splits the offset itself. */
	if (syscall(SYS_pread64, fd, high_pointer + 8, 4, (long)(uint32_t)high,
		    (long)(high >> 32)) != 4)
		test_perror("syscall(SYS_pread64) above 4 GiB into a buffer above 2 GiB");
	if (memcmp(high_pointer + 8, "high", 4) != 0)
		test_fail("syscall(SYS_pread64) above 4 GiB read the wrong bytes");
	/*
	 * musl's pwrite() tries pwritev2 first, whose offset is already an
	 * explicit pair, so only a raw call reaches sys_pwrite64. A lost high
	 * word writes below 4 GiB; swapped words write past the end.
	 */
	if (syscall(SYS_pwrite64, fd, "raw!", 4, (long)(uint32_t)(high + 4),
		    (long)((high + 4) >> 32)) != 4)
		test_perror("syscall(SYS_pwrite64) above 4 GiB");
	if (pread(fd, buffer, 4, high + 4) != 4 || memcmp(buffer, "raw!", 4) != 0)
		test_fail("syscall(SYS_pwrite64) above 4 GiB wrote different bytes");
	if (pread(fd, buffer, 4, (off_t)(uint32_t)(high + 4)) != 4 ||
	    memcmp(buffer, (char[4]){ 0 }, 4) != 0)
		test_fail("syscall(SYS_pwrite64) above 4 GiB also wrote below 4 GiB");
	expect_size(fd, high + sizeof(data), "syscall(SYS_pwrite64) above 4 GiB");

	if (lseek(fd, 0, SEEK_END) != high + (off_t)sizeof(data))
		test_perror("lseek(SEEK_END) above 4 GiB");
	if (lseek(fd, -(off_t)sizeof(data), SEEK_CUR) != high)
		test_perror("lseek with a negative SEEK_CUR offset");
	if (lseek(fd, -6 * GIB, SEEK_CUR) != -1 || errno != EINVAL)
		test_fail("lseek before the start of the file did not fail with EINVAL");

	ret = fallocate(fd, 0, 6 * GIB, 65536);
	if (ret == -1)
		test_perror("fallocate above 4 GiB");
	expect_size(fd, 6 * GIB + 65536, "fallocate above 4 GiB");
	ret = posix_fallocate(fd, 7 * GIB, 4096);
	if (ret != 0) {
		errno = ret;
		test_perror("posix_fallocate above 4 GiB");
	}
	expect_size(fd, 7 * GIB + 4096, "posix_fallocate above 4 GiB");

	ret = posix_fadvise(fd, 5 * GIB, 4096, POSIX_FADV_DONTNEED);
	if (ret != 0) {
		errno = ret;
		test_perror("posix_fadvise above 4 GiB");
	}
	ret = posix_fadvise(fd, 0, 5 * GIB, POSIX_FADV_WILLNEED);
	if (ret != 0) {
		errno = ret;
		test_perror("posix_fadvise over 5 GiB");
	}
	/* The advice slot follows two pairs of slots. */
	if (posix_fadvise(fd, 0, 0, 99) != EINVAL)
		test_fail("posix_fadvise accepted invalid advice");
	if (posix_fadvise(fd, 0, -5 * GIB, POSIX_FADV_NORMAL) != EINVAL)
		test_fail("posix_fadvise accepted a negative length");
	/* With its words swapped this length would be negative. */
	ret = posix_fadvise(fd, 0, 0x80000000LL, POSIX_FADV_NORMAL);
	if (ret != 0) {
		errno = ret;
		test_perror("posix_fadvise over 2 GiB");
	}

	/* readahead succeeds for any offset, so this only checks it is reached. */
	if (readahead(fd, 5 * GIB, 4096) == -1)
		test_perror("readahead above 4 GiB");

	if (sync_file_range(fd, 5 * GIB, 4096, SYNC_FILE_RANGE_WRITE) == -1)
		test_perror("sync_file_range above 4 GiB");
	/* The range end overflows only when the length's high word arrives. */
	expect_error(sync_file_range(fd, 0x7fffffff00000000LL, 0x7fffffff00000000LL,
				     SYNC_FILE_RANGE_WRITE),
		     EINVAL, "sync_file_range with an overflowing range");

	if (close(fd) == -1)
		test_perror("close");
	if (unlinkat(AT_FDCWD, path, 0) == -1)
		test_perror("unlinkat(AT_FDCWD)");

	test_pass();
}
