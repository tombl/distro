#pragma once

#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>

static _Noreturn void test_fail(const char *message)
{
	printf("::tombl-vm-test::fail: %s\n", message);
	fflush(stdout);
	for (;;)
		sched_yield();
}

static _Noreturn void test_perror(const char *operation)
{
	char message[256];

	snprintf(message, sizeof(message), "%s: %s", operation, strerror(errno));
	test_fail(message);
}

static _Noreturn void test_pass(void)
{
	puts("::tombl-vm-test::pass");
	fflush(stdout);
	for (;;)
		sched_yield();
}
