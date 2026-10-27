#define _GNU_SOURCE
#include "test.h"

#include <signal.h>
#include <stdlib.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <unistd.h>

static long traced_word = 0x5eed1234;

static int child(void *arg)
{
	(void)arg;
	if (ptrace(PTRACE_TRACEME, 0, 0, 0) == -1)
		return 1;
	if (raise(SIGSTOP) != 0)
		return 2;
	/* The tracer pokes the word while this child is stopped. */
	return traced_word == 0x600df00d ? 0 : 3;
}

int main(void)
{
	const size_t stack_size = 64 * 1024;
	char *stack = malloc(stack_size);
	int status;
	long word;
	pid_t pid;

	if (!stack)
		test_perror("malloc");

	pid = clone(child, stack + stack_size, SIGCHLD, 0);
	if (pid == -1)
		test_perror("clone");
	if (waitpid(pid, &status, 0) != pid)
		test_perror("waitpid stop");
	if (!WIFSTOPPED(status) || WSTOPSIG(status) != SIGSTOP)
		test_fail("tracee did not stop with SIGSTOP");

	errno = 0;
	word = ptrace(PTRACE_PEEKDATA, pid, &traced_word, 0);
	if (word == -1 && errno)
		test_perror("PTRACE_PEEKDATA");
	if (word != 0x5eed1234)
		test_fail("PTRACE_PEEKDATA read the wrong word");
	if (ptrace(PTRACE_POKEDATA, pid, &traced_word, (void *)0x600df00d) == -1)
		test_perror("PTRACE_POKEDATA");
	if (traced_word != 0x5eed1234)
		test_fail("PTRACE_POKEDATA wrote the tracer's memory");

	/* Requests without wasm register state fail instead of trapping. */
	if (ptrace(PTRACE_GETREGS, pid, 0, 0) != -1 || errno != EIO)
		test_fail("PTRACE_GETREGS did not fail with EIO");

	if (ptrace(PTRACE_DETACH, pid, 0, 0) == -1)
		test_perror("PTRACE_DETACH");
	if (waitpid(pid, &status, 0) != pid)
		test_perror("waitpid exit");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("tracee did not see the poked word");

	free(stack);
	test_pass();
}
