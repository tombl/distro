#define _GNU_SOURCE
#include "test.h"

#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static _Alignas(16) char child_stack[64 * 1024];
static volatile sig_atomic_t seen_signal;
static volatile sig_atomic_t seen_code;
static volatile sig_atomic_t seen_pid;
static volatile sig_atomic_t seen_uid;
static volatile sig_atomic_t seen_value;
static volatile sig_atomic_t seen_status;
static volatile sig_atomic_t seen_utime;
static volatile sig_atomic_t seen_stime;
static volatile sig_atomic_t seen_timerid;
static volatile sig_atomic_t seen_overrun;
static volatile sig_atomic_t handler_write_ok;
static volatile sig_atomic_t nested_error;
static volatile sig_atomic_t nested_outer_seen;
static volatile sig_atomic_t nested_inner_seen;
static int handler_write_fd = -1;

__attribute__((import_module("linux"), import_name("copy_siginfo")))
int __wasm_copy_siginfo(siginfo_t *);

struct child_args {
	pid_t parent;
	int signal_number;
	int write_fd;
};

static void info_handler(int signal_number, siginfo_t *info, void *context)
{
	(void)context;
	seen_signal = signal_number;
	seen_code = info->si_code;
	seen_pid = info->si_pid;
	seen_uid = info->si_uid;
	seen_value = info->si_value.sival_int;
	if (signal_number == SIGCHLD) {
		seen_status = info->si_status;
		seen_utime = info->si_utime;
		seen_stime = info->si_stime;
	}
	if (info->si_code == SI_TIMER) {
		seen_timerid = info->si_timerid;
		seen_overrun = info->si_overrun;
	}
	if (handler_write_fd >= 0) {
		char byte = 'H';

		handler_write_ok = write(handler_write_fd, &byte, 1) == 1;
	}
}

static void nested_info_handler(int signal_number, siginfo_t *info,
				void *context)
{
	siginfo_t copied;

	(void)context;
	if (__wasm_copy_siginfo(&copied) != 0 ||
	    copied.si_signo != signal_number || copied.si_code != SI_TKILL) {
		nested_error = 1;
		return;
	}
	if (signal_number == SIGUSR2) {
		nested_inner_seen = 1;
		return;
	}
	if (signal_number != SIGUSR1) {
		nested_error = 2;
		return;
	}

	nested_outer_seen = 1;
	if (raise(SIGUSR2) != 0) {
		nested_error = 3;
		return;
	}
	if (__wasm_copy_siginfo(&copied) != 0 ||
	    copied.si_signo != SIGUSR1 || copied.si_code != SI_TKILL)
		nested_error = 4;
}

static void plain_handler(int signal_number)
{
	seen_signal = signal_number;
}

static int signal_child(void *opaque)
{
	struct child_args *args = opaque;
	struct timespec delay = { .tv_nsec = 100 * 1000 * 1000 };
	char byte = 'R';

	nanosleep(&delay, NULL);
	if (kill(args->parent, args->signal_number) == -1)
		return 10;
	if (args->write_fd >= 0) {
		nanosleep(&delay, NULL);
		if (write(args->write_fd, &byte, 1) != 1)
			return 11;
	}
	return 0;
}

static pid_t start_signal_child(int signal_number, int write_fd)
{
	struct child_args args = {
		.parent = getpid(),
		.signal_number = signal_number,
		.write_fd = write_fd,
	};
	pid_t pid = clone(signal_child, child_stack + sizeof(child_stack),
			  SIGCHLD, &args);

	if (pid == -1)
		test_perror("clone signal child");
	return pid;
}

static void wait_success(pid_t pid)
{
	int status;

	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid signal child");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("signal child failed");
}

static void test_kill_siginfo_and_eintr(void)
{
	struct sigaction action = {
		.sa_sigaction = info_handler,
		.sa_flags = SA_SIGINFO,
	};
	int handler_pipe[2];
	int pipefd[2];
	char byte;
	pid_t pid;
	ssize_t ret;

	if (sigemptyset(&action.sa_mask) == -1 ||
	    sigaction(SIGUSR1, &action, NULL) == -1)
		test_perror("install SA_SIGINFO handler");
	if (pipe(pipefd) == -1 || pipe(handler_pipe) == -1)
		test_perror("pipe for EINTR");

	seen_signal = 0;
	handler_write_ok = 0;
	handler_write_fd = handler_pipe[1];
	pid = start_signal_child(SIGUSR1, -1);
	errno = 0;
	ret = read(pipefd[0], &byte, 1);
	handler_write_fd = -1;
	if (ret != -1 || errno != EINTR)
		test_fail("handled signal did not interrupt read with exactly EINTR");
	if (!handler_write_ok || read(handler_pipe[0], &byte, 1) != 1 || byte != 'H')
		test_fail("signal handler syscall did not complete correctly");
	wait_success(pid);
	if (seen_signal != SIGUSR1 || seen_code != SI_USER || seen_pid != pid ||
	    seen_uid != getuid())
		test_fail("kill siginfo source fields were incorrect");
	close(pipefd[0]);
	close(pipefd[1]);
	close(handler_pipe[0]);
	close(handler_pipe[1]);
}

static void test_restart(void)
{
	struct sigaction action = {
		.sa_handler = plain_handler,
		.sa_flags = SA_RESTART,
	};
	int pipefd[2];
	char byte = 0;
	pid_t pid;

	if (sigemptyset(&action.sa_mask) == -1 ||
	    sigaction(SIGUSR2, &action, NULL) == -1)
		test_perror("install SA_RESTART handler");
	if (pipe(pipefd) == -1)
		test_perror("pipe for SA_RESTART");

	seen_signal = 0;
	pid = start_signal_child(SIGUSR2, pipefd[1]);
	if (read(pipefd[0], &byte, 1) != 1 || byte != 'R')
		test_perror("SA_RESTART read");
	wait_success(pid);
	if (seen_signal != SIGUSR2)
		test_fail("SA_RESTART handler was not called");
	close(pipefd[0]);
	close(pipefd[1]);
}

static void test_timer_siginfo(void)
{
	static const int expected = 0x51a17;
	struct sigaction action = {
		.sa_sigaction = info_handler,
		.sa_flags = SA_SIGINFO,
	};
	struct sigevent event = {
		.sigev_notify = SIGEV_SIGNAL,
		.sigev_signo = SIGALRM,
		.sigev_value.sival_int = expected,
	};
	struct itimerspec time = {
		.it_value.tv_nsec = 100 * 1000 * 1000,
	};
	struct timespec delay = { .tv_sec = 2 };
	timer_t timer;

	if (sigemptyset(&action.sa_mask) == -1 ||
	    sigaction(SIGALRM, &action, NULL) == -1)
		test_perror("install timer SA_SIGINFO handler");
	if (timer_create(CLOCK_MONOTONIC, &event, &timer) == -1)
		test_perror("timer_create");
	seen_signal = 0;
	if (timer_settime(timer, 0, &time, NULL) == -1)
		test_perror("timer_settime");
	if (nanosleep(&delay, NULL) != -1 || errno != EINTR)
		test_fail("timer signal did not interrupt nanosleep with EINTR");
	if (seen_signal != SIGALRM || seen_code != SI_TIMER ||
	    seen_value != expected)
		test_fail("timer siginfo value or code was incorrect");
	if (seen_timerid != (int)(uintptr_t)timer || seen_overrun != 0)
		test_fail("timer siginfo id or overrun was incorrect");
	if (timer_delete(timer) == -1)
		test_perror("timer_delete");
}

static int status_child(void *unused)
{
	(void)unused;
	return 37;
}

static void test_sigchld_info(void)
{
	struct sigaction action = {
		.sa_sigaction = info_handler,
		.sa_flags = SA_SIGINFO,
	};
	int status;
	pid_t pid;

	if (sigemptyset(&action.sa_mask) == -1 ||
	    sigaction(SIGCHLD, &action, NULL) == -1)
		test_perror("install SIGCHLD SA_SIGINFO handler");
	seen_signal = 0;
	pid = clone(status_child, child_stack + sizeof(child_stack), SIGCHLD, NULL);
	if (pid == -1)
		test_perror("clone status child");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid status child");
	if (seen_signal != SIGCHLD || seen_code != CLD_EXITED ||
	    seen_pid != pid || seen_uid != getuid() || seen_status != 37)
		test_fail("SIGCHLD identity or status fields were incorrect");
	if (seen_utime < 0 || seen_stime < 0)
		test_fail("SIGCHLD CPU-time fields were negative");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 37)
		test_fail("status child did not exit with status 37");
}

static void test_nested_siginfo(void)
{
	struct sigaction action = {
		.sa_sigaction = nested_info_handler,
		.sa_flags = SA_SIGINFO,
	};
	siginfo_t outside;

	if (__wasm_copy_siginfo(&outside) != -EINVAL)
		test_fail("siginfo copy was available outside signal delivery");
	if (sigemptyset(&action.sa_mask) == -1 ||
	    sigaction(SIGUSR1, &action, NULL) == -1 ||
	    sigaction(SIGUSR2, &action, NULL) == -1)
		test_perror("install nested SA_SIGINFO handlers");
	nested_error = 0;
	nested_outer_seen = 0;
	nested_inner_seen = 0;
	if (raise(SIGUSR1) != 0)
		test_perror("raise outer nested signal");
	if (nested_error || !nested_outer_seen || !nested_inner_seen)
		test_fail("nested signal delivery lost its active siginfo payload");
	if (__wasm_copy_siginfo(&outside) != -EINVAL)
		test_fail("siginfo copy remained active after signal delivery");
}

static void test_queued_siginfo(void)
{
	static const int expected = 0x51a18;
	struct sigaction action = {
		.sa_sigaction = info_handler,
		.sa_flags = SA_SIGINFO,
	};
	union sigval value = { .sival_int = expected };

	if (sigemptyset(&action.sa_mask) == -1 ||
	    sigaction(SIGUSR1, &action, NULL) == -1)
		test_perror("install queued SA_SIGINFO handler");
	seen_signal = 0;
	if (sigqueue(getpid(), SIGUSR1, value) == -1)
		test_perror("sigqueue");
	if (seen_signal != SIGUSR1 || seen_code != SI_QUEUE ||
	    seen_pid != getpid() || seen_uid != getuid() ||
	    seen_value != expected)
		test_fail("queued siginfo source fields or value were incorrect");
}

static void test_raise_code(void)
{
	struct sigaction action = {
		.sa_sigaction = info_handler,
		.sa_flags = SA_SIGINFO,
	};

	if (sigemptyset(&action.sa_mask) == -1 ||
	    sigaction(SIGTERM, &action, NULL) == -1)
		test_perror("install raise SA_SIGINFO handler");
	seen_signal = 0;
	if (raise(SIGTERM) == -1)
		test_perror("raise");
	if (seen_signal != SIGTERM || seen_code != SI_TKILL)
		test_fail("raise siginfo code was incorrect");
}

static void test_sigaltstack(void)
{
	stack_t old;

	errno = 0;
	if (sigaltstack(NULL, &old) != -1 || errno != ENOSYS)
		test_fail("sigaltstack did not fail with ENOSYS");
}

int main(void)
{
	test_kill_siginfo_and_eintr();
	test_restart();
	test_timer_siginfo();
	test_sigchld_info();
	test_queued_siginfo();
	test_raise_code();
	test_nested_siginfo();
	test_sigaltstack();
	test_pass();
}
