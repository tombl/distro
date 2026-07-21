#include "test.h"

#include <pthread.h>
#include <unistd.h>

static void cancelled(void *unused)
{
	(void)unused;
	test_pass();
}

int main(void)
{
	int pipefd[2];
	char byte;

	if (pipe(pipefd) == -1)
		test_perror("pipe");
	pthread_cleanup_push(cancelled, NULL);
	if (pthread_cancel(pthread_self()) != 0)
		test_fail("pthread_cancel failed");
	if (read(pipefd[0], &byte, 1) == -1)
		test_perror("read");
	pthread_cleanup_pop(0);
	test_fail("cancelled read returned");
}
