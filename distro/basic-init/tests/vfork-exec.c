#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

/*
 * A CLONE_VM child runs on its parent's user memory, so its exec runs the new
 * image in the child's own worker rather than in a successor. Each case here
 * execs from a CLONE_VM child: the parent must be released at exec, keep its
 * memory, and see the new image run; a failed exec must leave the child able
 * to exec again; and the exec'd image must be able to exec on, including from
 * signal handlers.
 */
enum { handler_rounds = 200, spawn_rounds = 100 };

static const size_t stack_size = 64 * 1024;
static char *stacks[2];
static volatile int sentinel = 0x5eed;

static void exec_self(const char *mode, const char *arg)
{
	char *argv[] = { "/init", (char *)mode, (char *)arg, NULL };
	char *envp[] = { NULL };

	execve("/init", argv, envp);
}

static pid_t clone_child(int (*fn)(void *), void *arg, int flags, int slot)
{
	pid_t pid = clone(fn, stacks[slot] + stack_size, flags | SIGCHLD, arg);

	if (pid == -1)
		test_perror("clone");
	return pid;
}

static void expect_exit(pid_t pid, int code, const char *what)
{
	char message[128];
	int status;

	if (waitpid(pid, &status, 0) != pid)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != code) {
		snprintf(message, sizeof(message), "%s: status %#x, want exit %d",
			 what, status, code);
		test_fail(message);
	}
}

static void expect_parent_memory(const char *what)
{
	char message[128];
	char *p;

	if (sentinel != 0x5eed) {
		snprintf(message, sizeof(message), "%s: parent memory changed", what);
		test_fail(message);
	}
	p = malloc(1 << 20);
	if (!p)
		test_perror("malloc after a child exec");
	memset(p, 0xa5, 1 << 20);
	free(p);
}

/* vfork: the parent must resume at exec, before the new image exits. */
static int gate[2];

static int vfork_child(void *unused)
{
	char fd[16];

	(void)unused;
	snprintf(fd, sizeof(fd), "%d", gate[0]);
	exec_self("wait-gate", fd);
	_exit(127);
}

static void vfork_releases_parent(void)
{
	pid_t pid;

	if (pipe(gate) != 0)
		test_perror("pipe");
	pid = clone_child(vfork_child, NULL, CLONE_VM | CLONE_VFORK, 0);
	/* The child's image waits for this, so its exec must have released us. */
	if (write(gate[1], "x", 1) != 1)
		test_perror("write gate");
	close(gate[0]);
	close(gate[1]);
	expect_exit(pid, 0, "vfork child");
	expect_parent_memory("vfork");
}

/* CLONE_VM without CLONE_VFORK: the parent keeps running beside the exec. */
static volatile int clone_vm_execing;

static int clone_vm_child(void *unused)
{
	(void)unused;
	clone_vm_execing = 1;
	exec_self("exit", "7");
	_exit(127);
}

static void clone_vm_exec(void)
{
	pid_t pid;

	clone_vm_execing = 0;
	pid = clone_child(clone_vm_child, NULL, CLONE_VM, 0);
	/* Without preemption, a busy wait would never let the child run. */
	while (!clone_vm_execing)
		sched_yield();
	expect_exit(pid, 7, "CLONE_VM child");
	expect_parent_memory("CLONE_VM");
}

/* musl's posix_spawn uses CLONE_VM | CLONE_VFORK. */
static void posix_spawn_loop(void)
{
	char *argv[] = { "/init", "exit", "0", NULL };
	char *envp[] = { NULL };
	pid_t pid;
	int i, err;

	for (i = 0; i < spawn_rounds; i++) {
		err = posix_spawn(&pid, "/init", NULL, NULL, argv, envp);
		if (err) {
			errno = err;
			test_perror("posix_spawn");
		}
		expect_exit(pid, 0, "posix_spawn child");
	}
	expect_parent_memory("posix_spawn");
}

/*
 * A failed exec leaves the child running on the parent's memory, including
 * one that fails after the new image's memory was allocated.
 */
static int failing_child(void *unused)
{
	enum { args = 60000 };
	static char *argv[args + 2];
	char *bad_argv[] = { "/bin/data-past-memory", NULL };
	char *envp[] = { NULL };
	int i;

	(void)unused;
	argv[0] = "/init";
	for (i = 1; i <= args; i++)
		argv[i] = "";
	argv[args + 1] = NULL;
	/* Fits the argument pages, but not the process arguments: E2BIG. */
	execve("/init", argv, envp);
	if (errno != E2BIG)
		_exit(100);
	execve("/nonexistent", argv + args, envp);
	if (errno != ENOENT)
		_exit(101);
	/* Compiles and gets its memory, then fails to instantiate. */
	execve(bad_argv[0], bad_argv, envp);
	if (errno != ENOEXEC && errno != ENOMEM)
		_exit(103);
	exec_self("exit", "0");
	_exit(102);
}

static void failed_exec_then_exec(void)
{
	pid_t pid = clone_child(failing_child, NULL, CLONE_VM | CLONE_VFORK, 0);

	expect_exit(pid, 0, "child after failed execs");
	expect_parent_memory("failed exec");
}

/*
 * The new image's start function runs before the exec commits, on the
 * parent's side of it, so its syscalls and siginfo copies fail, including
 * when a SA_SIGINFO handler execs it. The image then exits with 5.
 */
static void exec_start_syscall(void)
{
	char *argv[] = { "/bin/start-syscall", NULL };
	char *envp[] = { NULL };

	execve(argv[0], argv, envp);
}

static void exec_start_syscall_handler(int sig, siginfo_t *info, void *context)
{
	(void)sig;
	(void)info;
	(void)context;
	exec_start_syscall();
	_exit(127);
}

static int start_syscall_child(void *from_handler)
{
	struct sigaction action;

	if (!from_handler) {
		exec_start_syscall();
		_exit(127);
	}
	memset(&action, 0, sizeof(action));
	action.sa_sigaction = exec_start_syscall_handler;
	action.sa_flags = SA_SIGINFO;
	if (sigaction(SIGUSR2, &action, NULL) != 0)
		_exit(125);
	kill(getpid(), SIGUSR2);
	_exit(124);
}

/*
 * A SA_SIGINFO handler whose exec fails in the new image's start function,
 * after that copied siginfo, returns normally.
 */
static volatile int failed_exec_errno;

static void failed_exec_handler(int sig, siginfo_t *info, void *context)
{
	char *argv[] = { "/bin/start-trap", NULL };
	char *envp[] = { NULL };

	(void)sig;
	(void)info;
	(void)context;
	execve(argv[0], argv, envp);
	failed_exec_errno = errno;
}

static int failed_exec_handler_child(void *unused)
{
	struct sigaction action;

	(void)unused;
	memset(&action, 0, sizeof(action));
	action.sa_sigaction = failed_exec_handler;
	action.sa_flags = SA_SIGINFO;
	if (sigaction(SIGUSR2, &action, NULL) != 0)
		_exit(125);
	kill(getpid(), SIGUSR2);
	_exit(failed_exec_errno == ENOEXEC ? 0 : 109);
}

static void start_function_syscall(void)
{
	pid_t pid;
	int i;

	for (i = 0; i < 2; i++) {
		pid = clone_child(start_syscall_child, i ? (void *)1 : NULL,
				  CLONE_VM | CLONE_VFORK, 0);
		expect_exit(pid, 5, i ? "image with a start function, from a handler" :
				       "image with a start function");
		expect_parent_memory("start function");
	}
	pid = clone_child(failed_exec_handler_child, NULL,
			  CLONE_VM | CLONE_VFORK, 0);
	expect_exit(pid, 0, "SA_SIGINFO handler after a failed exec");
	expect_parent_memory("start function trap");
}

/*
 * The vfork child execs from a signal handler. The new image then keeps
 * execing from handlers, alternating plain and SA_SIGINFO ones, in what is
 * now its own memory.
 */
static char next_round[16] = "0";

static void exec_from_handler(int sig)
{
	(void)sig;
	exec_self("handler-chain", next_round);
	_exit(127);
}

static void exec_from_siginfo_handler(int sig, siginfo_t *info, void *context)
{
	(void)context;
	if (info->si_signo != sig)
		_exit(126);
	exec_self("handler-chain", next_round);
	_exit(127);
}

/* A SIGUSR2 handler whose nested SIGUSR1 handler execs. */
static void signal_nested(int sig)
{
	(void)sig;
	kill(getpid(), SIGUSR1);
	_exit(123);
}

static _Noreturn void raise_exec(int siginfo, int nested)
{
	struct sigaction action;
	sigset_t usr1;

	sigemptyset(&usr1);
	sigaddset(&usr1, SIGUSR1);
	if (sigprocmask(SIG_UNBLOCK, &usr1, NULL) != 0)
		_exit(125);
	memset(&action, 0, sizeof(action));
	if (siginfo) {
		action.sa_sigaction = exec_from_siginfo_handler;
		action.sa_flags = SA_SIGINFO;
	} else {
		action.sa_handler = exec_from_handler;
	}
	if (sigaction(SIGUSR1, &action, NULL) != 0)
		_exit(125);
	if (nested && signal(SIGUSR2, signal_nested) == SIG_ERR)
		_exit(125);
	/* raise() would signal the thread whose TLS a CLONE_VM child shares. */
	kill(getpid(), nested ? SIGUSR2 : SIGUSR1);
	_exit(124);
}

static int handler_child(void *mode)
{
	raise_exec((long)mode & 1, (long)mode & 2);
}

static void handler_exec(long mode)
{
	pid_t pid = clone_child(handler_child, (void *)mode,
				CLONE_VM | CLONE_VFORK, 0);

	expect_exit(pid, 0, "handler exec");
	expect_parent_memory("handler exec");
}

/*
 * The parent is gone before its CLONE_VM child execs, so the child is the
 * last user of the memory.
 */
static int orphan_gate[2];

static int orphan_child(void *unused)
{
	char byte;

	(void)unused;
	close(orphan_gate[1]);
	/* EOF once the parent, the last other holder, has exited. */
	if (read(orphan_gate[0], &byte, 1) != 0)
		_exit(123);
	exec_self("spawn", "0");
	_exit(127);
}

static int orphan_parent(void *unused)
{
	(void)unused;
	if (pipe(orphan_gate) != 0)
		_exit(122);
	clone_child(orphan_child, NULL, CLONE_VM, 1);
	_exit(0);
}

static void orphaned_exec(void)
{
	pid_t pid;
	int status;

	/* A fork, so that the child's memory is not also init's. */
	pid = clone_child(orphan_parent, NULL, 0, 0);
	expect_exit(pid, 0, "orphan parent");
	/* The orphaned child is reparented to init. */
	pid = wait(&status);
	if (pid == -1)
		test_perror("wait for the orphaned child");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("orphaned CLONE_VM child failed to exec");
}

static void handler_exec_plain(void)
{
	handler_exec(0);
}

static void handler_exec_siginfo(void)
{
	handler_exec(1);
}

static void handler_exec_nested(void)
{
	handler_exec(2);
}

static void run(const char *name, void (*test)(void))
{
	test();
	printf("vfork-exec: %s: ok\n", name);
	fflush(stdout);
}

static int leaf(char **argv)
{
	long n = strtol(argv[2], NULL, 10);
	sigset_t mask;
	char byte;
	int status;
	pid_t pid;

	if (!strcmp(argv[1], "exit"))
		_exit(n);
	if (!strcmp(argv[1], "wait-gate")) {
		if (read(n, &byte, 1) != 1)
			_exit(121);
		_exit(0);
	}
	if (!strcmp(argv[1], "spawn"))
		goto spawn;
	if (strcmp(argv[1], "handler-chain"))
		_exit(115);
	/* The handler's signal stays blocked across execve. */
	if (sigprocmask(SIG_BLOCK, NULL, &mask) != 0 ||
	    !sigismember(&mask, SIGUSR1))
		_exit(114);
	if (n < handler_rounds) {
		snprintf(next_round, sizeof(next_round), "%ld", n + 1);
		raise_exec(n % 2 == 0, 0);
	}

spawn:
	/* Now the owner of its memory, vfork a child of its own. */
	stacks[0] = malloc(stack_size);
	if (!stacks[0])
		_exit(120);
	if (pipe(gate) != 0)
		_exit(119);
	pid = clone_child(vfork_child, NULL, CLONE_VM | CLONE_VFORK, 0);
	if (write(gate[1], "x", 1) != 1)
		_exit(118);
	if (waitpid(pid, &status, 0) != pid)
		_exit(117);
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		_exit(116);
	_exit(0);
}

int main(int argc, char **argv)
{
	if (argc > 2)
		return leaf(argv);

	stacks[0] = malloc(stack_size);
	stacks[1] = malloc(stack_size);
	if (!stacks[0] || !stacks[1])
		test_perror("malloc");

	run("vfork releases the parent", vfork_releases_parent);
	run("CLONE_VM exec", clone_vm_exec);
	run("posix_spawn", posix_spawn_loop);
	run("failed exec, then exec", failed_exec_then_exec);
	run("syscall from a start function", start_function_syscall);
	run("exec from a handler", handler_exec_plain);
	run("exec from a SA_SIGINFO handler", handler_exec_siginfo);
	run("exec from a nested handler", handler_exec_nested);
	run("exec after the parent exited", orphaned_exec);
	test_pass();
}
