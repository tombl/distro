#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/*
 * A user buffer that runs off the end of linear memory is valid up to the
 * end. Like a buffer that runs into an unmapped page on Linux, transfers
 * stop there: a write copies the valid prefix instead of spinning in the
 * kernel, and a read fills it.
 */
enum { valid = 100, length = 200, stack_size = 64 * 1024 };

static char *end;

static int writer(void *arg)
{
	int fd = *(int *)arg;
	ssize_t written;

	for (int i = 0; i < valid; i++)
		end[i - valid] = 'w';
	written = write(fd, end - valid, length);
	return written == valid ? 0 : 1;
}

int main(void)
{
	char *stack = malloc(stack_size);
	struct timespec pause = { .tv_nsec = 100 * 1000 * 1000 };
	char buffer[length];
	int status, fd, zero;
	ssize_t got;
	pid_t pid;

	if (!stack)
		test_perror("malloc");
	/* A page of our own at the end of memory, which malloc never hands out. */
	if (__builtin_wasm_memory_grow(0, 1) == (size_t)-1)
		test_fail("memory.grow failed");
	end = (char *)(uintptr_t)(__builtin_wasm_memory_size(0) * 65536);
	fd = open("/tmp/partial-copy", O_RDWR | O_CREAT | O_TRUNC, 0600);
	if (fd == -1)
		test_perror("open");

	/* The writer may spin in the kernel; run it where it can be killed. */
	pid = clone(writer, stack + stack_size, SIGCHLD, &fd);
	if (pid == -1)
		test_perror("clone writer");
	for (int i = 0; i < 50; i++) {
		pid_t done = waitpid(pid, &status, WNOHANG);

		if (done == pid)
			break;
		if (done == -1)
			test_perror("waitpid writer");
		if (i == 49) {
			kill(pid, SIGKILL);
			waitpid(pid, &status, 0);
			test_fail("write of a buffer ending past memory hung");
		}
		nanosleep(&pause, 0);
	}
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("write past the end of memory was not short");

	if (pread(fd, buffer, length, 0) != valid)
		test_perror("pread written prefix");
	for (int i = 0; i < valid; i++)
		if (buffer[i] != 'w')
			test_fail("short write stored the wrong bytes");

	/* A read into the same range fills the valid prefix. */
	memset(buffer, 'r', sizeof(buffer));
	if (pwrite(fd, buffer, sizeof(buffer), 0) != sizeof(buffer))
		test_perror("pwrite");
	got = pread(fd, end - valid, length, 0);
	if (got != valid)
		test_fail("read past the end of memory was not short");
	for (int i = 0; i < valid; i++)
		if (end[i - valid] != 'r')
			test_fail("short read stored the wrong bytes");

	/* Zeroing the same range, as a read from /dev/zero does, also stops. */
	if (mknod("/tmp/zero", S_IFCHR | 0600, makedev(1, 5)) == -1)
		test_perror("mknod /dev/zero");
	zero = open("/tmp/zero", O_RDONLY);
	if (zero == -1)
		test_perror("open /dev/zero");
	memset(end - valid, 'r', valid);
	got = read(zero, end - valid, length);
	if (got != valid)
		test_fail("zeroing past the end of memory was not short");
	for (int i = 0; i < valid; i++)
		if (end[i - valid] != 0)
			test_fail("short zeroing left the wrong bytes");

	free(stack);
	test_pass();
}
