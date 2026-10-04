#define _GNU_SOURCE
#include "test.h"

#include <linux/futex.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int source_word;
static int word;
static int ready_pipe[2];
static int release_pipe[2];

static void *waiter(void *unused)
{
	(void)unused;
	if (syscall(SYS_futex, &source_word, FUTEX_WAIT_PRIVATE, 0, NULL) == -1)
		test_perror("futex wait");
	return NULL;
}

static int child(void *unused)
{
	pthread_t thread;
	struct timespec start, now;
	uintptr_t address = (uintptr_t)&word;
	char byte;
	long moved;

	(void)unused;
	word = 42;
	if (pthread_create(&thread, NULL, waiter, NULL))
		test_fail("create futex waiter");
	if (clock_gettime(CLOCK_MONOTONIC, &start))
		test_perror("clock_gettime");
	/* A successful requeue proves the thread is queued on word, without
	 * waking it. The pipe notification alone would not prove readiness. */
	do {
		moved = syscall(SYS_futex, &source_word, FUTEX_CMP_REQUEUE_PRIVATE,
				0, 1, &word, 0);
		if (moved == -1)
			test_perror("requeue futex waiter");
		if (clock_gettime(CLOCK_MONOTONIC, &now))
			test_perror("clock_gettime");
		if (!moved && now.tv_sec - start.tv_sec >= 10)
			test_fail("futex waiter did not queue");
		sched_yield();
	} while (!moved);
	if (write(ready_pipe[1], &address, sizeof(address)) != sizeof(address))
		test_perror("report queued futex address");
	if (read(release_pipe[0], &byte, 1) != 1)
		test_perror("wait for parent probe");
	if (syscall(SYS_futex, &word, FUTEX_WAKE_PRIVATE, 1) != 1)
		test_fail("same-mm wake did not find its waiter");
	if (pthread_join(thread, NULL))
		test_fail("join futex waiter");
	return 0;
}

int main(void)
{
	const size_t stack_size = 64 * 1024;
	char *stack = malloc(stack_size);
	uintptr_t address;
	pid_t pid;
	int status;
	char byte = 1;

	if (!stack)
		test_perror("malloc");
	if (pipe(ready_pipe) || pipe(release_pipe))
		test_perror("pipe");
	/* No CLONE_VM: identical addresses, but separate user memories. */
	pid = clone(child, stack + stack_size, SIGCHLD, NULL);
	if (pid == -1)
		test_perror("clone without CLONE_VM");
	if (read(ready_pipe[0], &address, sizeof(address)) != sizeof(address))
		test_perror("read queued futex address");
	if (address != (uintptr_t)&word || word != 0)
		test_fail("expected identical addresses in separate memories");
	/* Assert the wake count, not whether WAIT returned spuriously. */
	if (syscall(SYS_futex, &word, FUTEX_WAKE_PRIVATE, 1) != 0)
		test_fail("private futex wake crossed into another mm");
	if (write(release_pipe[1], &byte, 1) != 1)
		test_perror("release child");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status))
		test_fail("futex child failed");
	free(stack);
	test_pass();
}
