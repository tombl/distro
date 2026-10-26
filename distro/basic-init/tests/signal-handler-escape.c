#define _GNU_SOURCE
#include "test.h"

#include <setjmp.h>
#include <signal.h>
#include <stdlib.h>
#include <unistd.h>

/*
 * A handler that siglongjmps out abandons the kernel frames that delivered
 * it. Each escape must leave the task's kernel stack where it was: with
 * THREAD_SIZE at 128 KiB, a few hundred leaked delivery frames overflow it.
 */
enum { escapes = 10000 };

static sigjmp_buf env;
static volatile sig_atomic_t depth;

static void escape_handler(int signo)
{
	(void)signo;
	siglongjmp(env, 1);
}

static void nested_handler(int signo)
{
	(void)signo;
	depth++;
	/* A syscall from inside the handler delivers a second, escaping one. */
	if (raise(SIGUSR2) != 0)
		_exit(10);
	_exit(11);
}

static volatile sig_atomic_t second_entered, second_returned;

static void syscalling_handler(int signo)
{
	(void)signo;
	second_entered++;
	getppid();
	second_returned++;
}

int main(void)
{
	struct sigaction syscalling = { .sa_handler = syscalling_handler };
	struct sigaction escape = { .sa_handler = escape_handler };
	struct sigaction nested = { .sa_handler = nested_handler,
				    .sa_flags = SA_NODEFER };
	char byte = 0;
	sigset_t mask;
	int fds[2];

	if (sigemptyset(&syscalling.sa_mask) == -1 ||
	    sigemptyset(&escape.sa_mask) == -1 ||
	    sigaction(SIGUSR1, &escape, 0) == -1 ||
	    sigaction(SIGUSR2, &escape, 0) == -1)
		test_perror("install escaping handlers");
	if (pipe(fds) == -1)
		test_perror("pipe");

	for (volatile int i = 0; i < escapes; i++) {
		if (sigsetjmp(env, 1) == 0) {
			raise(SIGUSR1);
			test_fail("SIGUSR1 handler returned");
		}
	}

	/* Without a saved mask, the mask the handler ran with stays. */
	if (sigsetjmp(env, 0) == 0) {
		raise(SIGUSR1);
		test_fail("SIGUSR1 handler returned");
	}
	if (sigprocmask(SIG_SETMASK, 0, &mask) == -1)
		test_perror("read signal mask");
	if (sigismember(&mask, SIGUSR1) != 1)
		test_fail("an escape without a saved mask unblocked the signal");
	if (sigemptyset(&mask) == -1 ||
	    sigprocmask(SIG_SETMASK, &mask, 0) == -1)
		test_perror("unblock signals");

	if (sigemptyset(&nested.sa_mask) == -1 ||
	    sigaction(SIGUSR1, &nested, 0) == -1)
		test_perror("install nesting handler");
	for (volatile int i = 0; i < escapes / 10; i++) {
		if (sigsetjmp(env, 1) == 0) {
			raise(SIGUSR1);
			test_fail("SIGUSR1 handler returned");
		}
	}
	if (depth != escapes / 10)
		test_fail("nested handler ran the wrong number of times");

	/*
	 * With two signals pending, the first escapes without restoring a
	 * saved mask, so the second is deliverable under the handler's mask.
	 * It must not run beneath the escape, where its syscall would rethrow
	 * it, but at the next syscall afterwards.
	 */
	if (sigaction(SIGUSR1, &escape, 0) == -1 ||
	    sigaction(SIGUSR2, &syscalling, 0) == -1)
		test_perror("install pending-pair handlers");
	if (sigemptyset(&mask) == -1 || sigaddset(&mask, SIGUSR1) == -1 ||
	    sigaddset(&mask, SIGUSR2) == -1 ||
	    sigprocmask(SIG_SETMASK, &mask, 0) == -1)
		test_perror("block the pending pair");
	if (sigsetjmp(env, 0) == 0) {
		raise(SIGUSR1);
		raise(SIGUSR2);
		if (sigemptyset(&mask) == -1 ||
		    sigprocmask(SIG_SETMASK, &mask, 0) == -1)
			test_perror("unblock the pending pair");
		test_fail("SIGUSR1 handler returned");
	}
	if (second_entered || second_returned)
		test_fail("a second pending handler ran beneath an escape");
	/* Any syscall delivers it; this one leaves the mask and queue alone. */
	getppid();
	if (second_entered != 1 || second_returned != 1)
		test_fail("the second pending handler did not run afterwards");

	/* The kernel still services ordinary syscalls afterwards. */
	if (write(fds[1], &byte, 1) != 1 || read(fds[0], &byte, 1) != 1)
		test_perror("pipe round trip after escapes");
	test_pass();
}
