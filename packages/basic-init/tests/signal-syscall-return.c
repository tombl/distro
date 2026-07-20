#define _GNU_SOURCE
#include "test.h"

#include <setjmp.h>
#include <signal.h>
#include <stdint.h>

static volatile sig_atomic_t entered;

#ifdef USE_SJLJ
static sigjmp_buf env;
#endif

static void handler(int signo)
{
	if (signo == SIGUSR1)
		entered++;
}

int main(void)
{
	struct sigaction action = { .sa_handler = handler };

	printf("signal handler function pointer: %lu\n",
	       (unsigned long)(uintptr_t)handler);
	fflush(stdout);
	if (sigemptyset(&action.sa_mask) == -1 ||
	    sigaction(SIGUSR1, &action, NULL) == -1)
		test_perror("install SIGUSR1 handler");

#ifdef USE_SJLJ
	if (sigsetjmp(env, 1) != 0)
		test_fail("unexpected siglongjmp");
#endif

	if (raise(SIGUSR1) == -1)
		test_perror("raise(SIGUSR1)");
	if (entered != 1)
		test_fail("signal was not delivered on syscall return");
	test_pass();
}
