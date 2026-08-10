#include "test.h"

#include <linux/futex.h>
#include <stdatomic.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

int main(void)
{
	_Atomic int word = 0;
	_Atomic int operand = 41;
	struct timespec timeout = { .tv_nsec = 1 };

	if (syscall(SYS_futex, &word, FUTEX_WAIT_PRIVATE, 0, &timeout) != -1)
		test_fail("futex wait unexpectedly succeeded");
	if (errno != ETIMEDOUT)
		test_perror("futex wait");
	if (syscall(SYS_futex, &word, FUTEX_WAKE_OP_PRIVATE, 0, 0, &operand,
	    FUTEX_OP(FUTEX_OP_ADD, 1, FUTEX_OP_CMP_EQ, 41)) != 0)
		test_perror("futex wake op");
	if (operand != 42)
		test_fail("futex wake op did not update its operand");

	test_pass();
}
