#include "test.h"

#include <setjmp.h>

// Exercises the wasm32 setjmp/longjmp implementation (LLVM Wasm SjLj lowering
// backed by musl's __wasm_setjmp/__wasm_longjmp helpers). Built with
// -mllvm -wasm-enable-sjlj; without a working implementation the longjmp path
// traps with "RuntimeError: unreachable".

static jmp_buf jb;

// A couple of nested frames the longjmp must unwind straight through.
static _Noreturn void deepest(void)
{
	longjmp(jb, 42);
	test_fail("longjmp returned to its own frame");
}

static void middle(void)
{
	deepest();
	test_fail("a frame that longjmp unwound over kept running");
}

static void outer(void)
{
	middle();
	test_fail("a frame that longjmp unwound over kept running");
}

int main(void)
{
	// Non-local jump across nested frames, with a nonzero value preserved and
	// a volatile local surviving the jump.
	volatile int witness = 0;

	int ret = setjmp(jb);
	if (ret == 0) {
		witness = 7;
		outer();
		test_fail("setjmp's first return did not run the protected block");
	}

	if (ret != 42)
		test_fail("setjmp returned the wrong value after longjmp");
	if (witness != 7)
		test_fail("volatile local was not preserved across longjmp");

	// The standard requires longjmp(buf, 0) to make setjmp return 1.
	volatile int took_zero_path = 0;
	int ret2 = setjmp(jb);
	if (ret2 == 0) {
		took_zero_path = 1;
		longjmp(jb, 0);
		test_fail("longjmp(buf, 0) returned");
	}
	if (!took_zero_path)
		test_fail("second setjmp did not run its protected block first");
	if (ret2 != 1)
		test_fail("longjmp(buf, 0) did not make setjmp return 1");

	test_pass();
}
