#include "test.h"

static _Thread_local int tls_value = 41;

int main(void)
{
	if (tls_value != 41)
		test_fail("static TLS was not initialized");

	tls_value++;
	if (tls_value != 42)
		test_fail("static TLS was not writable");

	test_pass();
}
