#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mount.h>
#include <sys/wait.h>
#include <unistd.h>

/*
 * Reading another process's /proc files takes a temporary mm_users
 * reference on it. That reference must not make a single-threaded process
 * look multithreaded to clone() without CLONE_VM.
 */
enum { forks = 400, stack_size = 64 * 1024 };

struct reader_args {
	pid_t target;
	int ready;
};

static int reader(void *arg)
{
	struct reader_args *args = arg;
	char path[64], buffer[256];
	char byte = 1;

	snprintf(path, sizeof(path), "/proc/%d/cmdline", args->target);
	for (int reads = 0;; reads++) {
		int fd = open(path, O_RDONLY);

		if (fd == -1)
			return 1;
		if (read(fd, buffer, sizeof(buffer)) <= 0)
			return 2;
		close(fd);
		/* The target forks only once this has read its memory. */
		if (reads == 0 && write(args->ready, &byte, 1) != 1)
			return 3;
	}
}

static int child(void *arg)
{
	(void)arg;
	return 0;
}

int main(void)
{
	char *reader_stack = malloc(stack_size);
	char *child_stack = malloc(stack_size);
	struct reader_args args = { .target = getpid() };
	int status, ready[2];
	char byte;
	pid_t reader_pid;

	if (!reader_stack || !child_stack)
		test_perror("malloc");
	if (mount("proc", "/proc", "proc", 0, NULL) == -1 && errno != EBUSY)
		test_perror("mount /proc");

	if (pipe(ready) == -1)
		test_perror("pipe");
	args.ready = ready[1];
	reader_pid = clone(reader, reader_stack + stack_size, SIGCHLD, &args);
	if (reader_pid == -1)
		test_perror("clone reader");
	if (read(ready[0], &byte, 1) != 1)
		test_fail("/proc reader never read this process's cmdline");

	for (int i = 0; i < forks; i++) {
		pid_t pid = clone(child, child_stack + stack_size, SIGCHLD, 0);

		if (pid == -1) {
			char message[96];

			snprintf(message, sizeof(message),
				 "clone %d failed while /proc was read: %s", i,
				 strerror(errno));
			test_fail(message);
		}
		if (waitpid(pid, &status, 0) != pid)
			test_perror("waitpid child");
		if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
			test_fail("child failed");
	}

	if (kill(reader_pid, SIGKILL) == -1)
		test_perror("kill reader");
	if (waitpid(reader_pid, &status, 0) != reader_pid)
		test_perror("waitpid reader");
	if (!WIFSIGNALED(status) || WTERMSIG(status) != SIGKILL)
		test_fail("/proc reader stopped early");

	free(reader_stack);
	free(child_stack);
	test_pass();
}
