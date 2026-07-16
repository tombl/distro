#include "test.h"

#include <pthread.h>

int main(void)
{
	int old_state;

	if (pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &old_state) != 0)
		test_fail("pthread_setcancelstate failed");
	if (pthread_cancel(pthread_self()) != 0)
		test_fail("pthread_cancel failed");

	test_pass();
}
