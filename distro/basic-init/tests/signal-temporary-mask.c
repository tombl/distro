#define _GNU_SOURCE
#include "test.h"

#include <poll.h>
#include <signal.h>
#include <sys/select.h>
#include <unistd.h>

/*
 * sigsuspend, ppoll and pselect run with a temporary mask. When a handler
 * interrupts them, the caller's own mask comes back once it returns.
 */
static volatile sig_atomic_t handled;

static void handler(int signo)
{
	(void)signo;
	handled++;
}

static void check_restored(const char *call)
{
	char message[96];
	sigset_t current;

	if (sigprocmask(SIG_SETMASK, 0, &current) == -1)
		test_perror("read signal mask");
	if (sigismember(&current, SIGUSR1) != 1) {
		snprintf(message, sizeof(message),
			 "%s left its temporary signal mask installed", call);
		test_fail(message);
	}
}

int main(void)
{
	struct sigaction action = { .sa_handler = handler };
	sigset_t blocked, empty;
	struct timespec timeout = { .tv_sec = 5 };
	struct pollfd poll_fd;
	int fds[2];

	if (sigemptyset(&action.sa_mask) == -1 ||
	    sigaction(SIGUSR1, &action, 0) == -1)
		test_perror("sigaction");
	if (pipe(fds) == -1)
		test_perror("pipe");
	sigemptyset(&empty);
	sigemptyset(&blocked);
	sigaddset(&blocked, SIGUSR1);
	if (sigprocmask(SIG_SETMASK, &blocked, 0) == -1)
		test_perror("block SIGUSR1");

	/* Pending while blocked: each call's temporary mask unblocks it. */
	raise(SIGUSR1);
	if (sigsuspend(&empty) != -1 || errno != EINTR || handled != 1)
		test_fail("sigsuspend did not run the handler");
	check_restored("sigsuspend");

	raise(SIGUSR1);
	poll_fd = (struct pollfd) { .fd = fds[0], .events = POLLIN };
	if (ppoll(&poll_fd, 1, &timeout, &empty) != -1 || errno != EINTR ||
	    handled != 2)
		test_fail("ppoll did not run the handler");
	check_restored("ppoll");

	raise(SIGUSR1);
	{
		fd_set readable;

		FD_ZERO(&readable);
		FD_SET(fds[0], &readable);
		if (pselect(fds[0] + 1, &readable, 0, 0, &timeout, &empty) !=
			    -1 ||
		    errno != EINTR || handled != 3)
			test_fail("pselect did not run the handler");
	}
	check_restored("pselect");

	test_pass();
}
