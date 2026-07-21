#define _GNU_SOURCE
#include "test.h"

#include <setjmp.h>
#include <signal.h>

#define sh_setjmp(env) sigsetjmp((env), 1)

static sigjmp_buf saved_mask_env;
static sigjmp_buf unsaved_mask_env;
static sigjmp_buf outer_env;
static sigjmp_buf inner_env;
static sigjmp_buf macro_env;

static void set_mask(int signo)
{
	sigset_t mask;

	if (sigemptyset(&mask) == -1)
		test_perror("sigemptyset");
	if (signo && sigaddset(&mask, signo) == -1)
		test_perror("sigaddset");
	if (sigprocmask(SIG_SETMASK, &mask, 0) == -1)
		test_perror("sigprocmask(SIG_SETMASK)");
}

static int is_blocked(int signo)
{
	sigset_t mask;

	if (sigprocmask(SIG_SETMASK, 0, &mask) == -1)
		test_perror("sigprocmask(read)");
	return sigismember(&mask, signo);
}

static void test_saved_mask(void)
{
	set_mask(SIGUSR1);
	int ret = sigsetjmp(saved_mask_env, 1);
	if (ret == 0) {
		set_mask(0);
		if (is_blocked(SIGUSR1) != 0)
			test_fail("SIGUSR1 remained blocked after explicit unblock");
		if (raise(SIGUSR1) == -1)
			test_perror("raise(SIGUSR1)");
		siglongjmp(saved_mask_env, 17);
	}
	if (ret != 17)
		test_fail("siglongjmp returned the wrong value");
	if (is_blocked(SIGUSR1) != 1)
		test_fail("sigsetjmp(env, 1) did not restore its saved mask");
}

static void test_unsaved_mask(void)
{
	set_mask(SIGUSR1);
	int ret = sigsetjmp(unsaved_mask_env, 0);
	if (ret == 0) {
		set_mask(0);
		siglongjmp(unsaved_mask_env, 19);
	}
	if (ret != 19)
		test_fail("siglongjmp from sigsetjmp(env, 0) returned the wrong value");
	if (is_blocked(SIGUSR1) != 0)
		test_fail("sigsetjmp(env, 0) unexpectedly restored the signal mask");
}

static void test_nested(void)
{
	volatile int inner_landed = 0;

	set_mask(SIGUSR1);
	int outer_ret = sigsetjmp(outer_env, 1);
	if (outer_ret == 0) {
		set_mask(SIGUSR2);
		int inner_ret = sigsetjmp(inner_env, 1);
		if (inner_ret == 0) {
			set_mask(0);
			siglongjmp(inner_env, 23);
		}
		if (inner_ret != 23)
			test_fail("nested inner siglongjmp returned the wrong value");
		if (is_blocked(SIGUSR1) != 0 || is_blocked(SIGUSR2) != 1)
			test_fail("nested inner siglongjmp restored the wrong mask");
		inner_landed = 1;
		set_mask(0);
		siglongjmp(outer_env, 29);
	}
	if (outer_ret != 29 || !inner_landed)
		test_fail("nested outer siglongjmp did not land correctly");
	if (is_blocked(SIGUSR1) != 1 || is_blocked(SIGUSR2) != 0)
		test_fail("nested outer siglongjmp restored the wrong mask");
}

static void test_macro_indirection(void)
{
	set_mask(SIGUSR1);
	int ret = sh_setjmp(macro_env);
	if (ret == 0) {
		set_mask(0);
		siglongjmp(macro_env, 43);
	}
	if (ret != 43 || is_blocked(SIGUSR1) != 1)
		test_fail("sh_setjmp-style macro indirection did not work");
}

int main(void)
{
	struct sigaction ignore = { .sa_handler = SIG_IGN };

	if (sigemptyset(&ignore.sa_mask) == -1 ||
	    sigaction(SIGUSR1, &ignore, 0) == -1)
		test_perror("ignore SIGUSR1 for mask test");
	test_saved_mask();
	test_unsaved_mask();
	test_nested();
	test_macro_indirection();
	test_pass();
}
