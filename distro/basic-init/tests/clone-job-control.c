#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

enum { stack_size = 64 * 1024 };

struct stopped_child_args {
	int ready_fd;
	int continue_fd;
};

static int self_group_child(void *unused)
{
	pid_t pid = getpid();

	(void)unused;
	if (setpgid(0, 0) == -1)
		return 1;
	if (getpgrp() != pid || getpgid(0) != pid)
		return 2;
	errno = 0;
	if (setsid() != -1 || errno != EPERM)
		return 3;
	printf("clone job control: child setpgid created pgrp=%d; "
	       "setsid as group leader failed errno=%d (%s)\n",
	       pid, errno, strerror(errno));
	return 0;
}

static int stopped_child(void *opaque)
{
	struct stopped_child_args *args = opaque;
	char byte = 'R';

	if (write(args->ready_fd, &byte, 1) != 1)
		return 1;
	if (read(args->continue_fd, &byte, 1) != 1)
		return 2;
	if (setpgid(0, 0) == -1 || getpgrp() != getpid())
		return 3;
	if (write(args->ready_fd, &byte, 1) != 1)
		return 4;
	for (;;)
		pause();
}

static uint64_t monotonic_nanoseconds(void)
{
	struct timespec now;

	if (clock_gettime(CLOCK_MONOTONIC, &now) == -1)
		return 0;
	return (uint64_t)now.tv_sec * 1000000000 + now.tv_nsec;
}

static pid_t wait_state(pid_t pid, int *status, int flags)
{
	uint64_t deadline = monotonic_nanoseconds() + 1000000000;
	pid_t waited;

	do {
		waited = waitpid(pid, status, flags | WNOHANG);
		if (waited != 0)
			return waited;
		sched_yield();
	} while (monotonic_nanoseconds() < deadline);
	return 0;
}

static _Alignas(16) char stopped_stack[stack_size];

static int session_supervisor(void *unused)
{
	int ready[2];
	int proceed[2];
	char byte;
	int status;
	pid_t waited;
	pid_t pid;
	pid_t supervisor = getpid();
	struct sigaction ignore = { .sa_handler = SIG_IGN };
	struct stopped_child_args args;

	(void)unused;
	if (setsid() != supervisor)
		return 10;
	if (sigemptyset(&ignore.sa_mask) == -1 ||
	    sigaction(SIGTTOU, &ignore, 0) == -1)
		return 11;
	if (ioctl(STDIN_FILENO, TIOCSCTTY, 0) == -1) {
		printf("clone terminal control: TIOCSCTTY failed errno=%d (%s)\n",
		       errno, strerror(errno));
		return 12;
	}
	if (tcgetpgrp(STDIN_FILENO) != supervisor)
		return 13;
	if (pipe(ready) == -1 || pipe(proceed) == -1)
		return 13;
	args = (struct stopped_child_args) {
		.ready_fd = ready[1],
		.continue_fd = proceed[0],
	};
	pid = clone(stopped_child, stopped_stack + stack_size, SIGCHLD, &args);
	if (pid == -1)
		return 14;
	if (read(ready[0], &byte, 1) != 1)
		return 15;
	if (setpgid(pid, pid) == -1 || getpgid(pid) != pid)
		return 16;
	if (write(proceed[1], &byte, 1) != 1 || read(ready[0], &byte, 1) != 1)
		return 17;
	if (tcsetpgrp(STDIN_FILENO, pid) == -1 ||
	    tcgetpgrp(STDIN_FILENO) != pid)
		return 18;
	printf("clone terminal control: session=%d foreground pgrp=%d\n",
	       supervisor, pid);

	if (kill(pid, SIGTSTP) == -1)
		return 19;
	waited = wait_state(pid, &status, WUNTRACED);
	if (waited == pid && WIFSTOPPED(status) && WSTOPSIG(status) == SIGTSTP) {
		puts("clone wait states: SIGTSTP stopped child; WUNTRACED reported it");
	} else {
		puts("clone wait states: SIGTSTP did not produce a WUNTRACED stop");
		if (kill(pid, SIGSTOP) == -1)
			return 20;
		waited = wait_state(pid, &status, WUNTRACED);
		if (waited != pid || !WIFSTOPPED(status) ||
		    WSTOPSIG(status) != SIGSTOP)
			return 21;
		puts("clone wait states: SIGSTOP and WUNTRACED work");
	}

	if (kill(pid, SIGCONT) == -1)
		return 22;
	waited = wait_state(pid, &status, WCONTINUED);
	if (waited == pid && WIFCONTINUED(status))
		puts("clone wait states: SIGCONT resumed child; WCONTINUED reported it");
	else
		puts("clone wait states: WCONTINUED did not report SIGCONT");
	if (tcsetpgrp(STDIN_FILENO, supervisor) == -1)
		printf("clone terminal control: restoring supervisor foreground "
		       "failed errno=%d (%s)\n",
		       errno, strerror(errno));
	if (kill(pid, SIGTERM) == -1)
		return 24;
	if (waitpid(pid, &status, 0) == -1)
		return 25;
	if (!WIFSIGNALED(status) || WTERMSIG(status) != SIGTERM)
		return 26;
	return 0;
}

static void wait_for_exit(pid_t pid)
{
	int status;

	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid child exit");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		printf("clone job control: callback status=0x%x exit=%d\n", status,
		       WIFEXITED(status) ? WEXITSTATUS(status) : -1);
		test_fail("job-control callback child failed");
	}
}

static void test_child_setpgid_and_terminal(char *stack)
{
	pid_t pid = clone(self_group_child, stack + stack_size, SIGCHLD, 0);

	if (pid == -1)
		test_perror("self-setpgid clone");
	wait_for_exit(pid);

	pid = clone(session_supervisor, stack + stack_size, SIGCHLD, 0);
	if (pid == -1)
		test_perror("job-control supervisor clone");
	wait_for_exit(pid);
}

int main(void)
{
	char *stack = malloc(stack_size);

	if (!stack)
		test_perror("malloc");
	errno = 0;
	pid_t foreground = tcgetpgrp(STDIN_FILENO);
	if (foreground == -1)
		printf("clone terminal control: initial tcgetpgrp failed errno=%d "
		       "(%s)\n",
		       errno, strerror(errno));
	else
		printf("clone terminal control: initial foreground pgrp=%d\n",
		       foreground);

	test_child_setpgid_and_terminal(stack);
	free(stack);
	test_pass();
}
