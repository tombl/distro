#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t handled;

static void inherited_handler(int signal_number)
{
	if (signal_number == SIGUSR2)
		handled = 1;
}

static int child(void *unused)
{
	struct sigaction action;
	sigset_t mask;
	sigset_t pending;

	(void)unused;
	if (sigprocmask(SIG_SETMASK, NULL, &mask) == -1)
		return 1;
	if (sigismember(&mask, SIGUSR1) != 1)
		return 2;
	if (sigpending(&pending) == -1)
		return 3;
	if (sigismember(&pending, SIGUSR1) != 0)
		return 4;
	if (sigaction(SIGUSR2, NULL, &action) == -1)
		return 5;
	if (action.sa_handler != inherited_handler ||
	    !(action.sa_flags & SA_RESTART) ||
	    sigismember(&action.sa_mask, SIGTERM) != 1)
		return 6;
	if (raise(SIGUSR2) != 0 || !handled)
		return 7;

	puts("clone signals: mask and disposition inherited; pending signal clear; "
	     "inherited handler ran via raise");
	return 0;
}

int main(void)
{
	char *stack = malloc(64 * 1024);
	struct sigaction action = { .sa_handler = inherited_handler };
	sigset_t blocked;
	sigset_t pending;
	int received;
	int status;
	pid_t pid;

	if (!stack)
		test_perror("malloc");
	sigemptyset(&action.sa_mask);
	sigaddset(&action.sa_mask, SIGTERM);
	action.sa_flags = SA_RESTART;
	if (sigaction(SIGUSR2, &action, NULL) == -1)
		test_perror("sigaction");
	sigemptyset(&blocked);
	sigaddset(&blocked, SIGUSR1);
	if (sigprocmask(SIG_BLOCK, &blocked, NULL) == -1)
		test_perror("sigprocmask");
	if (raise(SIGUSR1) != 0)
		test_perror("raise blocked signal");

	pid = clone(child, stack + 64 * 1024, SIGCHLD, NULL);
	if (pid == -1)
		test_perror("signal-inheritance clone");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("clone child observed incorrect inherited signal state");
	if (sigpending(&pending) == -1)
		test_perror("parent sigpending");
	if (sigismember(&pending, SIGUSR1) != 1)
		test_fail("clone consumed the parent's pending signal");
	if (sigwait(&blocked, &received) != 0 || received != SIGUSR1)
		test_fail("sigwait did not synchronously consume parent signal");

	printf("clone signals: parent retained and synchronously consumed signal=%d\n",
	       received);
	free(stack);
	test_pass();
}
