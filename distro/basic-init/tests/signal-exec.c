#include "test.h"

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/*
 * An execve from a signal handler abandons the frames of the syscall that
 * delivered the signal. Execing in place leaked their kernel stack space on
 * every such exec, so enough rounds ran off the end of the 128 KiB kernel
 * stack. Each round here execs from a handler, alternating plain and
 * SA_SIGINFO handlers, well past that point.
 */
enum { rounds = 1200 };

static char next_round[16];

static void exec_next(void)
{
	char *argv[] = { "/init", next_round, NULL };
	char *envp[] = { NULL };

	execve("/init", argv, envp);
	test_perror("execve from a signal handler");
}

static void plain_handler(int sig)
{
	if (sig != SIGUSR1)
		test_fail("plain handler got the wrong signal");
	exec_next();
}

static void siginfo_handler(int sig, siginfo_t *info, void *context)
{
	(void)context;
	if (sig != SIGUSR1 || info->si_signo != SIGUSR1)
		test_fail("SA_SIGINFO handler got the wrong signal");
	exec_next();
}

int main(int argc, char **argv)
{
	long round = argc > 1 ? strtol(argv[1], NULL, 10) : 0;
	struct sigaction action;
	sigset_t usr1;

	if (round >= rounds)
		test_pass();
	snprintf(next_round, sizeof(next_round), "%ld", round + 1);

	/* The handler's signal stays blocked across execve. */
	sigemptyset(&usr1);
	sigaddset(&usr1, SIGUSR1);
	if (sigprocmask(SIG_UNBLOCK, &usr1, NULL) != 0)
		test_perror("sigprocmask");

	memset(&action, 0, sizeof(action));
	if (round % 2) {
		action.sa_sigaction = siginfo_handler;
		action.sa_flags = SA_SIGINFO;
	} else {
		action.sa_handler = plain_handler;
	}
	if (sigaction(SIGUSR1, &action, NULL) != 0)
		test_perror("sigaction");

	raise(SIGUSR1);
	test_fail("raise returned without the handler execing");
}
