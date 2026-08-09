#define _GNU_SOURCE
#include "test.h"

#include <setjmp.h>
#include <signal.h>

static sigjmp_buf env;
static volatile sig_atomic_t entered;

static void jump_handler(int signo)
{
	(void)signo;
	entered = 1;
	siglongjmp(env, 41);
}

int main(void)
{
	struct sigaction action = { .sa_handler = jump_handler };
	sigset_t mask;

	if (sigemptyset(&action.sa_mask) == -1 ||
	    sigaction(SIGUSR1, &action, 0) == -1)
		test_perror("install SIGUSR1 jump handler");
	if (sigemptyset(&mask) == -1 ||
	    sigprocmask(SIG_SETMASK, &mask, 0) == -1)
		test_perror("unblock signals");
	int ret = sigsetjmp(env, 1);
	if (ret == 0) {
		if (raise(SIGUSR1) == -1)
			test_perror("raise(SIGUSR1)");
		if (!entered)
			test_fail("signal handler was not delivered inside a SjLj frame");
		test_fail("siglongjmp returned to the signal handler");
	}
	if (ret != 41 || !entered)
		test_fail("handler siglongjmp landed incorrectly");
	if (sigprocmask(SIG_SETMASK, 0, &mask) == -1)
		test_perror("read restored signal mask");
	if (sigismember(&mask, SIGUSR1) != 0)
		test_fail("handler siglongjmp did not restore the saved mask");
	test_pass();
}
