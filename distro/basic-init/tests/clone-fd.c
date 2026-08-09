#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

struct child_args {
	int file_fd;
	int report_fd;
};

struct exec_args {
	int inherited_fd;
	int cloexec_fd;
};

static int child(void *opaque)
{
	struct child_args *args = opaque;
	char byte;
	int flags;

	if (read(args->file_fd, &byte, 1) != 1 || byte != 'a')
		return 1;
	if (fcntl(args->file_fd, F_SETFD, FD_CLOEXEC) == -1)
		return 2;
	flags = fcntl(args->file_fd, F_GETFL);
	if (flags == -1 || fcntl(args->file_fd, F_SETFL, flags | O_APPEND) == -1)
		return 3;
	if (close(args->file_fd) == -1)
		return 4;
	byte = 'R';
	if (write(args->report_fd, &byte, 1) != 1)
		return 5;
	if (close(args->report_fd) == -1)
		return 6;
	return 0;
}

static int exec_child(void *opaque)
{
	struct exec_args *args = opaque;
	char inherited[16];
	char cloexec[16];

	if (fcntl(args->cloexec_fd, F_SETFD, FD_CLOEXEC) == -1)
		return 1;
	snprintf(inherited, sizeof(inherited), "%d", args->inherited_fd);
	snprintf(cloexec, sizeof(cloexec), "%d", args->cloexec_fd);
	execl("/init", "init", "fd-exec-check", inherited, cloexec, NULL);
	return 2;
}

int main(int argc, char **argv)
{
	char *stack = malloc(64 * 1024);
	char contents[4];
	char byte;
	int report_pipe[2];
	int descriptor_flags;
	int status_flags;
	int status;
	int fd;
	off_t offset;
	pid_t pid;
	struct child_args args;
	struct exec_args exec_args;

	if (argc == 4 && !strcmp(argv[1], "fd-exec-check")) {
		int inherited = atoi(argv[2]);
		int cloexec = atoi(argv[3]);

		if (fcntl(inherited, F_GETFD) == -1)
			return 31;
		errno = 0;
		if (fcntl(cloexec, F_GETFD) != -1 || errno != EBADF)
			return 32;
		return 0;
	}

	if (!stack)
		test_perror("malloc");
	fd = open("/tmp/clone-fd", O_CREAT | O_TRUNC | O_RDWR, 0600);
	if (fd == -1)
		test_perror("open");
	if (write(fd, "abc", 3) != 3 || lseek(fd, 0, SEEK_SET) != 0)
		test_perror("prepare file");
	if (pipe(report_pipe) == -1)
		test_perror("pipe");
	args = (struct child_args) {
		.file_fd = fd,
		.report_fd = report_pipe[1],
	};

	pid = clone(child, stack + 64 * 1024, SIGCHLD, &args);
	if (pid == -1)
		test_perror("fd clone");
	if (close(report_pipe[1]) == -1)
		test_perror("close parent pipe writer");
	if (read(report_pipe[0], &byte, 1) != 1 || byte != 'R')
		test_fail("child pipe descriptor did not survive parent close");
	if (read(report_pipe[0], &byte, 1) != 0)
		test_fail("pipe did not reach EOF after both writers closed");
	offset = lseek(fd, 0, SEEK_CUR);
	if (offset == -1)
		test_perror("read shared file offset");
	if (offset != 1)
		test_fail("clone did not share the open file description offset");
	descriptor_flags = fcntl(fd, F_GETFD);
	if (descriptor_flags == -1)
		test_perror("read parent descriptor flags");
	if (descriptor_flags & FD_CLOEXEC)
		test_fail("clone shared per-descriptor FD_CLOEXEC state");
	status_flags = fcntl(fd, F_GETFL);
	if (status_flags == -1)
		test_perror("read parent file status flags");
	if (!(status_flags & O_APPEND))
		test_fail("clone did not share open-file-description status flags");
	if (write(fd, "Z", 1) != 1)
		test_perror("write through parent descriptor");
	if (pread(fd, contents, sizeof(contents), 0) != sizeof(contents) ||
	    memcmp(contents, "abcZ", sizeof(contents)) != 0)
		test_fail("shared O_APPEND state did not affect parent write");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("clone child failed descriptor checks");

	exec_args.inherited_fd = fd;
	exec_args.cloexec_fd = dup(fd);
	if (exec_args.cloexec_fd == -1)
		test_perror("dup close-on-exec descriptor");
	pid = clone(exec_child, stack + 64 * 1024, SIGCHLD, &exec_args);
	if (pid == -1)
		test_perror("close-on-exec clone");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid exec child");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("FD_CLOEXEC was not applied by execve");
	close(exec_args.cloexec_fd);

	printf("clone fd: parent offset=%lld fd_flags=0x%x status_flags=0x%x; "
	       "descriptor tables copied; close-on-exec honored; pipe references "
	       "and open file descriptions shared\n",
	       (long long)offset, descriptor_flags, status_flags);
	close(report_pipe[0]);
	close(fd);
	unlink("/tmp/clone-fd");
	free(stack);
	test_pass();
}
