#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum {
	reciprocal_iterations = 64,
	stack_size = 64 * 1024,
};

#define TARGET_WAIT_NS (10LL * 1000 * 1000 * 1000)
#define MAX_CANCEL_NS (8ULL * 1000 * 1000 * 1000)

static int wait_word;
static char probe[] = "remote-vm-parent";

static uint64_t monotonic_ns(void)
{
	struct timespec now;

	if (clock_gettime(CLOCK_MONOTONIC, &now) == -1)
		test_perror("clock_gettime");
	return (uint64_t)now.tv_sec * 1000000000 + now.tv_nsec;
}

static void write_byte(int fd)
{
	char byte = 1;

	if (write(fd, &byte, sizeof(byte)) != sizeof(byte))
		test_perror("write synchronization byte");
}

static void read_byte(int fd)
{
	char byte;

	if (read(fd, &byte, sizeof(byte)) != sizeof(byte))
		test_perror("read synchronization byte");
}

static int open_mem(pid_t pid)
{
	char path[64];
	int fd;

	snprintf(path, sizeof(path), "/proc/%d/mem", pid);
	fd = open(path, O_RDONLY);
	if (fd == -1)
		test_perror("open remote mem");
	return fd;
}

struct cancel_args {
	int ready;
	int parked;
	int release;
};

static int cancel_target(void *opaque)
{
	struct cancel_args *args = opaque;

	write_byte(args->ready);

	/*
	 * Block in the browser worker without entering the kernel. No poll point
	 * can service a remote request until this userspace wait expires.
	 */
	__builtin_wasm_memory_atomic_wait32(&wait_word, 0, TARGET_WAIT_NS);

	write_byte(args->parked);
	read_byte(args->release);
	return 0;
}

static void test_cancellation(void)
{
	struct cancel_args args;
	char *stack = malloc(stack_size);
	char result[sizeof(probe)] = { 0 };
	uint64_t before, elapsed;
	int ready[2], parked[2], release[2];
	int error, status, memfd;
	ssize_t length;
	pid_t pid;

	if (!stack)
		test_perror("malloc cancellation stack");
	if (pipe(ready) == -1 || pipe(parked) == -1 || pipe(release) == -1)
		test_perror("pipe cancellation synchronization");

	args = (struct cancel_args) {
		.ready = ready[1],
		.parked = parked[1],
		.release = release[0],
	};
	pid = clone(cancel_target, stack + stack_size, SIGCHLD, &args);
	if (pid == -1)
		test_perror("clone cancellation target");

	memfd = open_mem(pid);
	read_byte(ready[0]);
	/*
	 * Waking this process through the pipe can make the child reschedule at
	 * syscall exit. Let it return to userspace and enter the atomic wait
	 * before publishing the remote request.
	 */
	if (usleep(250000) == -1)
		test_perror("settle cancellation target");

	before = monotonic_ns();
	length = pread(memfd, result, sizeof(result),
		       (off_t)(uintptr_t)probe);
	error = errno;
	elapsed = monotonic_ns() - before;
	if (length != -1 || error != EIO)
		test_fail("busy target remote read did not cancel");
	if (elapsed >= MAX_CANCEL_NS)
		test_fail("busy target remote read exceeded its deadline");

	read_byte(parked[0]);
	length = pread(memfd, result, sizeof(result),
		       (off_t)(uintptr_t)probe);
	if (length != sizeof(result) ||
	    memcmp(result, probe, sizeof(result)) != 0)
		test_fail("parked target remote read returned wrong data");

	write_byte(release[1]);
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid cancellation target");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("cancellation target failed");
	length = pread(memfd, result, sizeof(result),
		       (off_t)(uintptr_t)probe);
	if (length != 0)
		test_fail("retained remote mem fd did not reach EOF after target exit");

	close(memfd);
	free(stack);
}

struct peer_args {
	pid_t peer;
	int send;
	int receive;
};

/*
 * Both peers publish and consume a synchronization byte before each access.
 * With two logical CPUs this repeatedly drives the A -> B / B -> A overlap;
 * each requester's wait loop must service the request addressed to itself.
 */
static int run_peer(pid_t peer, int send_fd, int receive_fd,
		    const char *local, const char *expected)
{
	char result[sizeof(probe)];
	int failed = 0;
	int memfd;

	memcpy(probe, local, sizeof(probe));
	memfd = open_mem(peer);

	for (int i = 0; i < reciprocal_iterations; i++) {
		char byte = 1;
		ssize_t length;

		if (write(send_fd, &byte, sizeof(byte)) != sizeof(byte) ||
		    read(receive_fd, &byte, sizeof(byte)) != sizeof(byte))
			return 1;
		length = pread(memfd, result, sizeof(result),
			       (off_t)(uintptr_t)probe);
		if (length != sizeof(result) ||
		    memcmp(result, expected, sizeof(result)) != 0)
			failed = 1;
		/* Keep either peer from exiting while the other's read is live. */
		if (write(send_fd, &byte, sizeof(byte)) != sizeof(byte) ||
		    read(receive_fd, &byte, sizeof(byte)) != sizeof(byte))
			return 1;
	}

	close(memfd);
	return failed;
}

static int reciprocal_child(void *opaque)
{
	struct peer_args *args = opaque;

	return run_peer(args->peer, args->send, args->receive,
			"remote-vm-child!", "remote-vm-parent");
}

static void test_reciprocal_access(void)
{
	struct peer_args args;
	char *stack = malloc(stack_size);
	int parent_to_child[2], child_to_parent[2];
	int parent_result;
	int status;
	pid_t pid;

	if (!stack)
		test_perror("malloc reciprocal stack");
	if (pipe(parent_to_child) == -1 || pipe(child_to_parent) == -1)
		test_perror("pipe reciprocal synchronization");

	args = (struct peer_args) {
		.peer = getpid(),
		.send = child_to_parent[1],
		.receive = parent_to_child[0],
	};
	pid = clone(reciprocal_child, stack + stack_size, SIGCHLD, &args);
	if (pid == -1)
		test_perror("clone reciprocal peer");

	parent_result = run_peer(pid, parent_to_child[1], child_to_parent[0],
				 "remote-vm-parent", "remote-vm-child!");
	if (waitpid(pid, &status, 0) == -1)
		test_perror("waitpid reciprocal peer");
	if (parent_result || !WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("reciprocal remote reads failed");

	free(stack);
}

int main(void)
{
	if (mkdir("/proc", 0555) == -1 && errno != EEXIST)
		test_perror("mkdir /proc");
	if (mount("proc", "/proc", "proc", 0, NULL) == -1 && errno != EBUSY)
		test_perror("mount proc");

	test_cancellation();
	test_reciprocal_access();
	test_pass();
}
