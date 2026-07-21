#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static _Alignas(16) char child_stack[64 * 1024];
static volatile sig_atomic_t clone_result;
static volatile sig_atomic_t clone_errno;

static int child(void *unused)
{
	(void)unused;
	return 29;
}

static void handler(int signal_number)
{
	int saved_errno = errno;
	pid_t pid;

	if (signal_number != SIGUSR1)
		return;
	errno = 0;
	pid = clone(child, child_stack + sizeof(child_stack), SIGCHLD, NULL);
	clone_result = pid;
	clone_errno = errno;
	errno = saved_errno;
}

int main(void)
{
	struct sigaction action = { .sa_handler = handler };
	int status;

	sigemptyset(&action.sa_mask);
	if (sigaction(SIGUSR1, &action, NULL) == -1)
		test_perror("sigaction");
	clone_result = -1;
	if (raise(SIGUSR1) != 0)
		test_perror("raise");
	if (clone_result == -1) {
		errno = clone_errno;
		test_perror("clone from signal handler");
	}
	if (clone_result <= 0)
		test_fail("signal handler did not record a child pid");
	if (waitpid(clone_result, &status, 0) == -1)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 29)
		test_fail("signal-handler clone callback returned wrong status");

	printf("signal-handler clone: synchronous raise created pid=%d, errno=%d; "
	       "callback exited 29\n",
	       clone_result, clone_errno);
	test_pass();
}
