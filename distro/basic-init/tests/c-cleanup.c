// C built with -fexceptions gets cleanup pads around every call that may
// unwind. Under wasm EH those must be funclets with the wasm personality:
// clang used to give C landingpads, which crashed the backend. The program
// links with the C driver only, so the pads must not pull in libc++abi.
#include "test.h"

static int released;

static void release(int *value)
{
	released += *value;
}

static void noop(void)
{
}

// An indirect call through a volatile pointer: nothing can prove it doesn't
// unwind, so the cleanup needs a pad.
static void (*volatile hook)(void) = noop;

static void scope(void)
{
	int guard __attribute__((cleanup(release))) = 1;

	hook();
}

int main(void)
{
	scope();
	if (released != 1)
		test_fail("cleanup did not run once on normal exit");
	test_pass();
}
