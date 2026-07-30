#define _GNU_SOURCE

#include "test.h"

#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <semaphore.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static volatile sig_atomic_t signal_count;
static volatile sig_atomic_t signal_post_result;
static sem_t *signal_sem;

typedef void (*handler_t)(int);
static void dummy0(int signal) { (void)signal; }
static void dummy1(int signal) { (void)signal; }
static void dummy2(int signal) { (void)signal; }
static void dummy3(int signal) { (void)signal; }
static void dummy4(int signal) { (void)signal; }
static handler_t volatile handler_slots[5];

static void signal_handler(int signal)
{
	int saved_errno = errno;

	(void)signal;
	signal_count++;
	if (signal_sem)
		signal_post_result = sem_post(signal_sem);
	errno = saved_errno;
}

static int write_all(int fd, const void *buffer, size_t length)
{
	const char *bytes = buffer;

	while (length) {
		ssize_t written = write(fd, bytes, length);

		if (written <= 0)
			return -1;
		bytes += written;
		length -= written;
	}
	return 0;
}

static int read_all(int fd, void *buffer, size_t length)
{
	char *bytes = buffer;

	while (length) {
		ssize_t received = read(fd, bytes, length);

		if (received <= 0)
			return -1;
		bytes += received;
		length -= received;
	}
	return 0;
}

static void sleep_ms(long milliseconds)
{
	struct timespec delay = {
		.tv_sec = milliseconds / 1000,
		.tv_nsec = milliseconds % 1000 * 1000000,
	};

	while (nanosleep(&delay, &delay) == -1 && errno == EINTR)
		;
}

static long long monotonic_ms(void)
{
	struct timespec now;

	if (clock_gettime(CLOCK_MONOTONIC, &now) == -1)
		test_perror("clock_gettime(CLOCK_MONOTONIC)");
	return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static struct timespec realtime_after_ms(long milliseconds)
{
	struct timespec deadline;

	if (clock_gettime(CLOCK_REALTIME, &deadline) == -1)
		test_perror("clock_gettime(CLOCK_REALTIME)");
	deadline.tv_sec += milliseconds / 1000;
	deadline.tv_nsec += milliseconds % 1000 * 1000000;
	if (deadline.tv_nsec >= 1000000000) {
		deadline.tv_sec++;
		deadline.tv_nsec -= 1000000000;
	}
	return deadline;
}

static pid_t spawn_child(char *const argv[])
{
	pid_t pid;
	int error = posix_spawn(&pid, "/init", NULL, NULL, argv, environ);

	if (error) {
		errno = error;
		test_perror("posix_spawn(/init)");
	}
	return pid;
}

static void wait_success(pid_t pid, const char *operation)
{
	int status;

	if (waitpid(pid, &status, 0) == -1)
		test_perror(operation);
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail(operation);
}

static int child_mutex(const char *name, const char *path, char id)
{
	char record[2] = { 'E', id };
	sem_t *sem = sem_open(name, 0);
	int fd;

	if (sem == SEM_FAILED || sem_wait(sem) == -1)
		return 10;
	fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
	if (fd == -1 || write_all(fd, record, sizeof(record)) == -1)
		return 11;
	sleep_ms(150);
	record[0] = 'L';
	if (write_all(fd, record, sizeof(record)) == -1)
		return 12;
	if (close(fd) == -1 || sem_post(sem) == -1 || sem_close(sem) == -1)
		return 13;
	return 0;
}

static int child_waiter(const char *name, int ready_fd, int wake_fd, char id)
{
	sem_t *sem = sem_open(name, 0);
	char ready = 'R';

	if (sem == SEM_FAILED)
		return 20;
	if (write_all(ready_fd, &ready, 1) == -1 || sem_wait(sem) == -1)
		return 21;
	if (write_all(wake_fd, &id, 1) == -1 || sem_close(sem) == -1)
		return 22;
	return 0;
}

static int child_create_race(const char *name, int start_fd, int result_fd)
{
	char start;
	char result;
	sem_t *sem;

	if (read_all(start_fd, &start, 1) == -1)
		return 30;
	errno = 0;
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 1);
	if (sem != SEM_FAILED) {
		result = 'S';
		if (sem_close(sem) == -1)
			return 31;
	} else if (errno == EEXIST) {
		result = 'E';
	} else {
		result = 'X';
	}
	return write_all(result_fd, &result, 1) == -1 ? 32 : 0;
}

static int child_lifetime(const char *name, int ready_fd, int go_fd)
{
	sem_t *sem = sem_open(name, 0);
	char byte = 'R';

	if (sem == SEM_FAILED || write_all(ready_fd, &byte, 1) == -1)
		return 40;
	if (read_all(go_fd, &byte, 1) == -1 || sem_post(sem) == -1)
		return 41;
	return sem_close(sem) == -1 ? 42 : 0;
}

static int child_signal(pid_t target, long delay_ms)
{
	sleep_ms(delay_ms);
	return kill(target, SIGUSR1) == -1 ? 50 : 0;
}

static int child_crash_waiter(const char *name, int ready_fd)
{
	sem_t *sem = sem_open(name, 0);
	char ready = 'R';

	if (sem == SEM_FAILED || write_all(ready_fd, &ready, 1) == -1)
		return 60;
	return sem_wait(sem) == -1 ? 61 : 62;
}

static int child_permissions(const char *name)
{
	sem_t *sem;

	if (setresgid(1000, 1000, 1000) == -1 ||
	    setresuid(1000, 1000, 1000) == -1)
		return 70;
	errno = 0;
	sem = sem_open(name, 0);
	if (sem != SEM_FAILED || errno != EACCES)
		return 71;
	errno = 0;
	if (sem_unlink(name) != -1 || errno != EACCES)
		return 72;
	return 0;
}

static int child_replace(const char *name)
{
	sem_t *sem;

	if (sem_unlink(name) == -1)
		return 80;
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
	if (sem == SEM_FAILED)
		return 81;
	return sem_close(sem) == -1 ? 82 : 0;
}

static int child_stress(const char *name, const char *path, int start_fd,
			int iterations)
{
	sem_t *sem = sem_open(name, 0);
	uint32_t value;
	char start;
	int fd;

	if (sem == SEM_FAILED)
		return 90;
	fd = open(path, O_RDWR);
	if (fd == -1 || read_all(start_fd, &start, 1) == -1)
		return 91;
	for (int i = 0; i < iterations; i++) {
		if (sem_wait(sem) == -1 || lseek(fd, 0, SEEK_SET) != 0 ||
		    read_all(fd, &value, sizeof(value)) == -1)
			return 92;
		value++;
		if (!(i % 5))
			sleep_ms(1);
		if (lseek(fd, 0, SEEK_SET) != 0 ||
		    write_all(fd, &value, sizeof(value)) == -1 ||
		    sem_post(sem) == -1)
			return 93;
	}
	if (close(fd) == -1 || sem_close(sem) == -1)
		return 94;
	return 0;
}

static int child_post(const char *name, int count)
{
	sem_t *sem = sem_open(name, 0);

	if (sem == SEM_FAILED)
		return 100;
	for (int i = 0; i < count; i++)
		if (sem_post(sem) == -1)
			return 101;
	return sem_close(sem) == -1 ? 102 : 0;
}

static int child_group_permissions(const char *name)
{
	sem_t *sem;

	if (setresgid(0, 0, 0) == -1 || setresuid(1000, 1000, 1000) == -1)
		return 110;
	sem = sem_open(name, 0);
	if (sem == SEM_FAILED || sem_close(sem) == -1)
		return 111;
	errno = 0;
	if (sem_unlink(name) != -1 || errno != EACCES)
		return 112;
	return 0;
}

static int child_main(int argc, char **argv)
{
	if (argc == 5 && !strcmp(argv[1], "mutex"))
		return child_mutex(argv[2], argv[3], argv[4][0]);
	if (argc == 6 && !strcmp(argv[1], "waiter"))
		return child_waiter(argv[2], atoi(argv[3]), atoi(argv[4]),
				    argv[5][0]);
	if (argc == 5 && !strcmp(argv[1], "create-race"))
		return child_create_race(argv[2], atoi(argv[3]), atoi(argv[4]));
	if (argc == 5 && !strcmp(argv[1], "lifetime"))
		return child_lifetime(argv[2], atoi(argv[3]), atoi(argv[4]));
	if (argc == 4 && !strcmp(argv[1], "signal"))
		return child_signal(atoi(argv[2]), atol(argv[3]));
	if (argc == 4 && !strcmp(argv[1], "crash-waiter"))
		return child_crash_waiter(argv[2], atoi(argv[3]));
	if (argc == 3 && !strcmp(argv[1], "permissions"))
		return child_permissions(argv[2]);
	if (argc == 3 && !strcmp(argv[1], "replace"))
		return child_replace(argv[2]);
	if (argc == 6 && !strcmp(argv[1], "stress"))
		return child_stress(argv[2], argv[3], atoi(argv[4]),
				    atoi(argv[5]));
	if (argc == 4 && !strcmp(argv[1], "post"))
		return child_post(argv[2], atoi(argv[3]));
	if (argc == 3 && !strcmp(argv[1], "group-permissions"))
		return child_group_permissions(argv[2]);
	return 99;
}

static sem_t thread_sem;
static int thread_woke;

static void *thread_waiter(void *unused)
{
	(void)unused;
	if (sem_wait(&thread_sem) == -1)
		return (void *)1;
	thread_woke = 1;
	return NULL;
}

static void run_unnamed_thread_semaphore(int pshared)
{
	pthread_t thread;
	void *result;

	thread_woke = 0;
	if (sem_init(&thread_sem, pshared, 0) == -1)
		test_perror("sem_init thread semaphore");
	if (pthread_create(&thread, NULL, thread_waiter, NULL) != 0)
		test_fail("pthread_create unnamed semaphore waiter");
	sleep_ms(20);
	if (thread_woke || sem_post(&thread_sem) == -1)
		test_fail("unnamed semaphore blocked state");
	if (pthread_join(thread, &result) != 0 || result || !thread_woke)
		test_fail("unnamed semaphore cross-thread wake");
	if (sem_destroy(&thread_sem) == -1)
		test_perror("sem_destroy");
}

static void test_unnamed_thread_semaphores(void)
{
	run_unnamed_thread_semaphore(0);
	run_unnamed_thread_semaphore(1);
}

struct cancel_waiter_args {
	sem_t *sem;
	int ready_fd;
};

struct cancel_disabled_waiter_args {
	sem_t *sem;
	int ready_fd;
	int acquired_fd;
};

static void *cancel_waiter(void *opaque)
{
	struct cancel_waiter_args *args = opaque;
	char ready = 'R';

	if (write_all(args->ready_fd, &ready, 1) == -1)
		return (void *)1;
	return sem_wait(args->sem) == -1 ? (void *)2 : NULL;
}

static void *cancel_disabled_waiter(void *opaque)
{
	struct cancel_disabled_waiter_args *args = opaque;
	char byte = 'R';

	if (pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, NULL) != 0)
		return (void *)1;
	if (write_all(args->ready_fd, &byte, 1) == -1)
		return (void *)2;
	if (sem_wait(args->sem) == -1)
		return (void *)3;
	byte = 'A';
	if (write_all(args->acquired_fd, &byte, 1) == -1)
		return (void *)4;
	if (pthread_setcancelstate(PTHREAD_CANCEL_ENABLE, NULL) != 0)
		return (void *)5;
	pthread_testcancel();
	return (void *)6;
}

static void test_named_wait_cancellation(void)
{
	const char *name = "/wasm-sem-cancel";
	struct cancel_waiter_args args;
	struct cancel_disabled_waiter_args disabled_args;
	pthread_t thread;
	void *result;
	sem_t *sem;
	int ready_pipe[2];
	int acquired_pipe[2];
	char byte;

	sem_unlink(name);
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
	if (sem == SEM_FAILED || pipe(ready_pipe) == -1)
		test_perror("prepare named semaphore cancellation");
	args.sem = sem;
	args.ready_fd = ready_pipe[1];
	if (pthread_create(&thread, NULL, cancel_waiter, &args) != 0 ||
	    read_all(ready_pipe[0], &byte, 1) == -1 || byte != 'R')
		test_fail("start named semaphore cancellation waiter");
	sleep_ms(20);
	if (pthread_cancel(thread) != 0 || pthread_join(thread, &result) != 0 ||
	    result != PTHREAD_CANCELED)
		test_fail("blocked named semaphore wait was not cancellable");
	if (sem_post(sem) == -1 || sem_trywait(sem) == -1)
		test_fail("cancelled named waiter retained a handoff");
	close(ready_pipe[0]);
	close(ready_pipe[1]);

	if (pipe(ready_pipe) == -1 || pipe(acquired_pipe) == -1)
		test_perror("prepare cancellation-disabled named waiter");
	disabled_args.sem = sem;
	disabled_args.ready_fd = ready_pipe[1];
	disabled_args.acquired_fd = acquired_pipe[1];
	if (pthread_create(&thread, NULL, cancel_disabled_waiter,
			   &disabled_args) != 0 ||
	    read_all(ready_pipe[0], &byte, 1) == -1 || byte != 'R')
		test_fail("start cancellation-disabled named waiter");
	if (pthread_cancel(thread) != 0)
		test_fail("cancel cancellation-disabled named waiter");
	sleep_ms(20);
	if (sem_post(sem) == -1 ||
	    read_all(acquired_pipe[0], &byte, 1) == -1 || byte != 'A' ||
	    pthread_join(thread, &result) != 0 || result != PTHREAD_CANCELED)
		test_fail("disabled cancellation did not defer across named wait");
	errno = 0;
	if (sem_trywait(sem) != -1 || errno != EAGAIN)
		test_fail("cancellation-disabled waiter did not consume its handoff");
	close(ready_pipe[0]);
	close(ready_pipe[1]);
	close(acquired_pipe[0]);
	close(acquired_pipe[1]);
	if (sem_close(sem) == -1 || sem_unlink(name) == -1)
		test_perror("cleanup named semaphore cancellation");
}

struct concurrent_open_args {
	const char *name;
	sem_t *expected;
	int iterations;
};

static void *concurrent_opener(void *opaque)
{
	struct concurrent_open_args *args = opaque;

	for (int i = 0; i < args->iterations; i++) {
		sem_t *sem = sem_open(args->name, 0);

		if (sem == SEM_FAILED)
			return (void *)1;
		if (sem != args->expected) {
			sem_close(sem);
			return (void *)2;
		}
		if (sem_close(sem) == -1)
			return (void *)3;
	}
	return NULL;
}

static void test_concurrent_open_identity(void)
{
	enum { THREADS = 2, ITERATIONS = 1000 };
	const char *name = "/wasm-sem-thread-opens";
	struct concurrent_open_args args;
	struct rlimit original;
	struct rlimit limited;
	pthread_t threads[THREADS];
	void *result;
	sem_t *sem;

	if (getrlimit(RLIMIT_NOFILE, &original) == -1)
		test_perror("getrlimit for concurrent semaphore opens");
	limited = original;
	if (limited.rlim_cur > 16)
		limited.rlim_cur = 16;
	if (setrlimit(RLIMIT_NOFILE, &limited) == -1)
		test_perror("limit descriptors for concurrent semaphore opens");
	sem_unlink(name);
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 1);
	if (sem == SEM_FAILED)
		test_perror("create concurrent-open semaphore");
	args = (struct concurrent_open_args) {
		.name = name,
		.expected = sem,
		.iterations = ITERATIONS,
	};
	for (int i = 0; i < THREADS; i++)
		if (pthread_create(&threads[i], NULL, concurrent_opener, &args) != 0)
			test_fail("start concurrent semaphore opener");
	for (int i = 0; i < THREADS; i++)
		if (pthread_join(threads[i], &result) != 0 || result)
			test_fail("concurrent sem_open identity or descriptor cleanup");
	if (sem_close(sem) == -1 || sem_unlink(name) == -1 ||
	    setrlimit(RLIMIT_NOFILE, &original) == -1)
		test_perror("cleanup concurrent semaphore opens");
}

static void test_values_and_overflow(void)
{
	const char *name = "/wasm-sem-values";
	const char *overflow_name = "/wasm-sem-overflow";
	const char *invalid_name = "/wasm-sem-invalid";
	sem_t *sem;
	sem_t *same;
	int value;

	sem_unlink(name);
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 2);
	if (sem == SEM_FAILED)
		test_perror("create value semaphore");
	if (sem_getvalue(sem, &value) == -1 || value != 2 || sem_wait(sem) == -1)
		test_fail("initial semaphore value");
	if (sem_getvalue(sem, &value) == -1 || value != 1 || sem_post(sem) == -1)
		test_fail("semaphore getvalue after wait");
	same = sem_open("////wasm-sem-values", O_CREAT, 0600, UINT_MAX);
	if (same == SEM_FAILED || same != sem)
		test_fail("repeated sem_open did not reuse the existing handle");
	if (sem_close(same) == -1 || sem_close(sem) == -1 ||
	    sem_unlink(name) == -1)
		test_perror("close value semaphore");

	sem_unlink(invalid_name);
	errno = 0;
	if (sem_open(invalid_name, O_CREAT | O_EXCL, 0600, UINT_MAX) !=
		SEM_FAILED || errno != EINVAL)
		test_fail("invalid initial semaphore value");

	sem_unlink(overflow_name);
	sem = sem_open(overflow_name, O_CREAT | O_EXCL, 0600, SEM_VALUE_MAX);
	if (sem == SEM_FAILED || sem_getvalue(sem, &value) == -1 ||
	    value != SEM_VALUE_MAX)
		test_fail("SEM_VALUE_MAX create and getvalue");
	errno = 0;
	if (sem_post(sem) != -1 || errno != EOVERFLOW)
		test_fail("SEM_VALUE_MAX overflow");
	if (sem_close(sem) == -1 || sem_unlink(overflow_name) == -1)
		test_perror("close overflow semaphore");
}

static void test_process_mutex(void)
{
	const char *name = "/wasm-sem-mutex";
	const char *path = "/tmp/wasm-sem-mutex.log";
	char contents[8];
	char *first[] = { "/init", "mutex", (char *)name, (char *)path, "0", NULL };
	char *second[] = { "/init", "mutex", (char *)name, (char *)path, "1", NULL };
	pid_t children[2];
	sem_t *sem;
	int fd;
	int value;

	sem_unlink(name);
	unlink(path);
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 1);
	if (sem == SEM_FAILED)
		test_perror("create process mutex");
	children[0] = spawn_child(first);
	children[1] = spawn_child(second);
	wait_success(children[0], "first mutex child");
	wait_success(children[1], "second mutex child");
	fd = open(path, O_RDONLY);
	if (fd == -1 || read_all(fd, contents, sizeof(contents)) == -1)
		test_perror("read mutex record");
	if (contents[0] != 'E' || contents[2] != 'L' ||
	    contents[1] != contents[3] || contents[4] != 'E' ||
	    contents[6] != 'L' || contents[5] != contents[7] ||
	    contents[1] == contents[5])
		test_fail("named semaphore did not exclude spawned processes");
	if (sem_getvalue(sem, &value) == -1 || value != 1)
		test_fail("mutex count after spawned processes");
	close(fd);
	unlink(path);
	if (sem_close(sem) == -1 || sem_unlink(name) == -1)
		test_perror("close process mutex");
}

static void test_process_contention_stress(void)
{
	enum { CHILDREN = 6, ITERATIONS = 50 };
	const char *name = "/wasm-sem-stress";
	const char *path = "/tmp/wasm-sem-stress-count";
	char start_fd[16];
	char iterations[16];
	char *argv[] = { "/init", "stress", (char *)name, (char *)path,
			 start_fd, iterations, NULL };
	char starts[CHILDREN];
	pid_t children[CHILDREN];
	uint32_t value = 0;
	sem_t *sem;
	int start_pipe[2];
	int fd;
	int sem_value;

	sem_unlink(name);
	unlink(path);
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 1);
	fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
	if (sem == SEM_FAILED || fd == -1 ||
	    write_all(fd, &value, sizeof(value)) == -1 || close(fd) == -1 ||
	    pipe(start_pipe) == -1)
		test_perror("prepare process semaphore stress");
	snprintf(start_fd, sizeof(start_fd), "%d", start_pipe[0]);
	snprintf(iterations, sizeof(iterations), "%d", ITERATIONS);
	for (int i = 0; i < CHILDREN; i++)
		children[i] = spawn_child(argv);
	memset(starts, 'G', sizeof(starts));
	if (write_all(start_pipe[1], starts, sizeof(starts)) == -1)
		test_perror("release process semaphore stress children");
	for (int i = 0; i < CHILDREN; i++)
		wait_success(children[i], "process semaphore stress child");
	fd = open(path, O_RDONLY);
	if (fd == -1 || read_all(fd, &value, sizeof(value)) == -1 ||
	    value != CHILDREN * ITERATIONS)
		test_fail("named semaphore lost a contended critical-section update");
	if (sem_getvalue(sem, &sem_value) == -1 || sem_value != 1)
		test_fail("stress semaphore did not finish at its initial value");
	close(fd);
	close(start_pipe[0]);
	close(start_pipe[1]);
	unlink(path);
	if (sem_close(sem) == -1 || sem_unlink(name) == -1)
		test_perror("cleanup process semaphore stress");
}

static void test_linked_persistence_and_getvalue(void)
{
	const char *name = "/wasm-sem-persistent";
	char *argv[] = { "/init", "post", (char *)name, "3", NULL };
	sem_t *sem;
	pid_t child;
	int value;

	sem_unlink(name);
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
	if (sem == SEM_FAILED || sem_close(sem) == -1)
		test_perror("create persistent named semaphore");
	child = spawn_child(argv);
	wait_success(child, "persistent semaphore child");
	sem = sem_open(name, 0);
	if (sem == SEM_FAILED || sem_getvalue(sem, &value) == -1 || value != 3)
		test_fail("linked semaphore did not persist across close and child exec");
	if (sem_close(sem) == -1 || sem_unlink(name) == -1)
		test_perror("cleanup persistent named semaphore");
}

static void test_wakeup_order(void)
{
	const char *name = "/wasm-sem-order";
	char ready_fd[16];
	char wake_fd[16];
	char ids[3][2] = { "0", "1", "2" };
	char *argv[] = { "/init", "waiter", (char *)name, ready_fd,
			 wake_fd, NULL, NULL };
	int ready_pipe[2];
	int wake_pipe[2];
	pid_t children[3];
	sem_t *sem;
	char byte;

	sem_unlink(name);
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
	if (sem == SEM_FAILED || pipe(ready_pipe) == -1 || pipe(wake_pipe) == -1)
		test_perror("prepare wakeup ordering");
	snprintf(ready_fd, sizeof(ready_fd), "%d", ready_pipe[1]);
	snprintf(wake_fd, sizeof(wake_fd), "%d", wake_pipe[1]);
	for (int i = 0; i < 3; i++) {
		argv[5] = ids[i];
		children[i] = spawn_child(argv);
		if (read_all(ready_pipe[0], &byte, 1) == -1 || byte != 'R')
			test_fail("waiter readiness");
		sleep_ms(30);
	}
	for (int i = 0; i < 3; i++) {
		if (sem_post(sem) == -1 || read_all(wake_pipe[0], &byte, 1) == -1)
			test_perror("ordered semaphore wake");
		if (byte != '0' + i)
			test_fail("semaphore waiters did not wake FIFO");
	}
	for (int i = 0; i < 3; i++)
		wait_success(children[i], "ordered waiter child");
	close(ready_pipe[0]);
	close(ready_pipe[1]);
	close(wake_pipe[0]);
	close(wake_pipe[1]);
	if (sem_close(sem) == -1 || sem_unlink(name) == -1)
		test_perror("close ordering semaphore");
}

static void test_exclusive_create_race(void)
{
	enum { CHILDREN = 6 };
	const char *name = "/wasm-sem-create-race";
	char start_fd[16];
	char result_fd[16];
	char *argv[] = { "/init", "create-race", (char *)name,
			 start_fd, result_fd, NULL };
	char starts[CHILDREN];
	char results[CHILDREN];
	int start_pipe[2];
	int result_pipe[2];
	pid_t children[CHILDREN];
	sem_t *sem;
	int successes = 0;

	sem_unlink(name);
	if (pipe(start_pipe) == -1 || pipe(result_pipe) == -1)
		test_perror("create race pipes");
	snprintf(start_fd, sizeof(start_fd), "%d", start_pipe[0]);
	snprintf(result_fd, sizeof(result_fd), "%d", result_pipe[1]);
	for (int i = 0; i < CHILDREN; i++)
		children[i] = spawn_child(argv);
	memset(starts, 'G', sizeof(starts));
	if (write_all(start_pipe[1], starts, sizeof(starts)) == -1 ||
	    read_all(result_pipe[0], results, sizeof(results)) == -1)
		test_perror("run exclusive create race");
	for (int i = 0; i < CHILDREN; i++) {
		if (results[i] == 'S')
			successes++;
		else if (results[i] != 'E')
			test_fail("unexpected exclusive create result");
		wait_success(children[i], "exclusive create child");
	}
	if (successes != 1)
		test_fail("O_CREAT|O_EXCL was not atomic");
	sem = sem_open(name, 0);
	if (sem == SEM_FAILED || sem_close(sem) == -1 || sem_unlink(name) == -1)
		test_perror("cleanup exclusive create race");
	close(start_pipe[0]);
	close(start_pipe[1]);
	close(result_pipe[0]);
	close(result_pipe[1]);
}

static void test_unlink_lifetime(void)
{
	const char *name = "/wasm-sem-lifetime";
	char ready_fd[16];
	char go_fd[16];
	char *argv[] = { "/init", "lifetime", (char *)name,
			 ready_fd, go_fd, NULL };
	int ready_pipe[2];
	int go_pipe[2];
	pid_t child;
	sem_t *old;
	sem_t *fresh;
	char byte;

	sem_unlink(name);
	old = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
	if (old == SEM_FAILED || pipe(ready_pipe) == -1 || pipe(go_pipe) == -1)
		test_perror("prepare unlink lifetime");
	snprintf(ready_fd, sizeof(ready_fd), "%d", ready_pipe[1]);
	snprintf(go_fd, sizeof(go_fd), "%d", go_pipe[0]);
	child = spawn_child(argv);
	if (read_all(ready_pipe[0], &byte, 1) == -1 || byte != 'R')
		test_fail("lifetime child readiness");
	if (sem_unlink(name) == -1)
		test_perror("unlink open semaphore");
	errno = 0;
	if (sem_open(name, 0) != SEM_FAILED || errno != ENOENT)
		test_fail("unlinked semaphore remained discoverable");
	fresh = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
	if (fresh == SEM_FAILED)
		test_perror("recreate unlinked semaphore");
	byte = 'G';
	if (write_all(go_pipe[1], &byte, 1) == -1 || sem_wait(old) == -1)
		test_fail("old semaphore lifetime after unlink");
	errno = 0;
	if (sem_trywait(fresh) != -1 || errno != EAGAIN)
		test_fail("recreated semaphore aliased unlinked object");
	wait_success(child, "unlink lifetime child");
	if (sem_close(old) == -1 || sem_close(fresh) == -1 ||
	    sem_unlink(name) == -1)
		test_perror("cleanup unlink lifetime");
	close(ready_pipe[0]);
	close(ready_pipe[1]);
	close(go_pipe[0]);
	close(go_pipe[1]);
}

static void test_crash_cleanup(void)
{
	const char *name = "/wasm-sem-crash";
	char ready_fd[16];
	char *argv[] = { "/init", "crash-waiter", (char *)name,
			 ready_fd, NULL };
	int ready_pipe[2];
	int status;
	pid_t child;
	sem_t *sem;
	char ready;

	sem_unlink(name);
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
	if (sem == SEM_FAILED || pipe(ready_pipe) == -1)
		test_perror("prepare crash cleanup");
	snprintf(ready_fd, sizeof(ready_fd), "%d", ready_pipe[1]);
	child = spawn_child(argv);
	if (read_all(ready_pipe[0], &ready, 1) == -1 || ready != 'R')
		test_fail("crash waiter readiness");
	sleep_ms(30);
	if (kill(child, SIGKILL) == -1 || waitpid(child, &status, 0) == -1)
		test_perror("kill semaphore waiter");
	if (!WIFSIGNALED(status) || WTERMSIG(status) != SIGKILL)
		test_fail("semaphore waiter did not die from SIGKILL");
	if (sem_post(sem) == -1 || sem_trywait(sem) == -1)
		test_fail("dead waiter leaked a queued handoff");
	if (sem_unlink(name) == -1 || sem_close(sem) == -1)
		test_perror("drop final crash semaphore references");
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 1);
	if (sem == SEM_FAILED || sem_trywait(sem) == -1 ||
	    sem_close(sem) == -1 || sem_unlink(name) == -1)
		test_fail("recreate after process-death cleanup");
	close(ready_pipe[0]);
	close(ready_pipe[1]);
}

static void test_external_unlink_identity(void)
{
	const char *name = "/wasm-sem-external-unlink";
	char *argv[] = { "/init", "replace", (char *)name, NULL };
	sem_t *old;
	sem_t *fresh;
	pid_t child;

	sem_unlink(name);
	old = sem_open(name, O_CREAT | O_EXCL, 0600, 1);
	if (old == SEM_FAILED)
		test_perror("create externally replaced semaphore");
	child = spawn_child(argv);
	wait_success(child, "external semaphore replacement child");
	fresh = sem_open(name, 0);
	if (fresh == SEM_FAILED || fresh == old)
		test_fail("recreated semaphore reused the unlinked object's handle");
	if (sem_trywait(old) == -1)
		test_fail("old semaphore did not retain its value after replacement");
	errno = 0;
	if (sem_trywait(fresh) != -1 || errno != EAGAIN)
		test_fail("new semaphore inherited the replaced object's value");
	if (sem_close(old) == -1 || sem_close(fresh) == -1 ||
	    sem_unlink(name) == -1)
		test_perror("cleanup externally replaced semaphore");
}

static void test_timedwait_and_interrupt(void)
{
	const char *name = "/wasm-sem-timed";
	char parent_pid[32];
	char *signal_argv[] = { "/init", "signal", parent_pid, "80", NULL };
	struct sigaction action = { .sa_handler = signal_handler };
	struct timespec deadline;
	long long started;
	long long elapsed;
	pid_t child;
	sem_t *sem;

	handler_slots[0] = dummy0;
	handler_slots[1] = dummy1;
	handler_slots[2] = dummy2;
	handler_slots[3] = dummy3;
	handler_slots[4] = dummy4;
	for (int i = 0; i < 5; i++)
		handler_slots[i](0);
	if (sigemptyset(&action.sa_mask) == -1 ||
	    sigaction(SIGUSR1, &action, NULL) == -1)
		test_perror("install semaphore signal handler");

	sem_unlink(name);
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
	if (sem == SEM_FAILED)
		test_perror("create timed semaphore");
	deadline = (struct timespec) { 0, 0 };
	started = monotonic_ms();
	errno = 0;
	if (sem_timedwait(sem, &deadline) != -1 || errno != ETIMEDOUT ||
	    monotonic_ms() - started > 1000)
		test_fail("expired sem_timedwait did not time out immediately");
	deadline = (struct timespec) { .tv_nsec = 1000000000 };
	if (sem_post(sem) == -1 || sem_timedwait(sem, &deadline) == -1)
		test_fail("available semaphore validated an unused timeout");
	deadline = realtime_after_ms(150);
	started = monotonic_ms();
	errno = 0;
	if (sem_timedwait(sem, &deadline) != -1 || errno != ETIMEDOUT)
		test_fail("sem_timedwait did not time out");
	elapsed = monotonic_ms() - started;
	if (elapsed < 100 || elapsed > 2000)
		test_fail("sem_timedwait timeout duration");

	snprintf(parent_pid, sizeof(parent_pid), "%d", getpid());
	child = spawn_child(signal_argv);
	errno = 0;
	if (sem_wait(sem) != -1 || errno != EINTR || signal_count != 1)
		test_fail("sem_wait did not report interrupting signal");
	wait_success(child, "sem_wait signal child");

	action.sa_flags = SA_RESTART;
	if (sigaction(SIGUSR1, &action, NULL) == -1)
		test_perror("install restarting semaphore signal handler");
	deadline = realtime_after_ms(250);
	started = monotonic_ms();
	child = spawn_child(signal_argv);
	errno = 0;
	if (sem_timedwait(sem, &deadline) != -1 || errno != ETIMEDOUT ||
	    signal_count != 2)
		test_fail("restarted sem_timedwait result");
	elapsed = monotonic_ms() - started;
	if (elapsed < 180 || elapsed > 2000)
		test_fail("signal restart extended absolute semaphore timeout");
	wait_success(child, "restarting timedwait signal child");

	signal_post_result = -1;
	signal_sem = sem;
	child = spawn_child(signal_argv);
	if (sem_wait(sem) == -1 || signal_post_result != 0 || signal_count != 3)
		test_fail("sem_post from a restarting signal handler did not wake sem_wait");
	signal_sem = NULL;
	wait_success(child, "signal-handler sem_post child");
	if (sem_close(sem) == -1 || sem_unlink(name) == -1)
		test_perror("cleanup timed semaphore");
}

static void test_permissions(void)
{
	const char *name = "/wasm-sem-permissions";
	const char *group_name = "/wasm-sem-group-permissions";
	char *argv[] = { "/init", "permissions", (char *)name, NULL };
	char *group_argv[] = { "/init", "group-permissions",
			       (char *)group_name, NULL };
	sem_t *sem;
	pid_t child;
	mode_t old_umask;

	sem_unlink(name);
	old_umask = umask(0077);
	sem = sem_open(name, O_CREAT | O_EXCL, 0666, 1);
	umask(old_umask);
	if (sem == SEM_FAILED)
		test_perror("create permission semaphore");
	child = spawn_child(argv);
	wait_success(child, "semaphore permission child");
	if (sem_close(sem) == -1 || sem_unlink(name) == -1)
		test_perror("cleanup permission semaphore");

	sem_unlink(group_name);
	old_umask = umask(0);
	sem = sem_open(group_name, O_CREAT | O_EXCL, 0060, 1);
	umask(old_umask);
	if (sem == SEM_FAILED)
		test_perror("create group permission semaphore");
	child = spawn_child(group_argv);
	wait_success(child, "group semaphore permission child");
	if (sem_close(sem) == -1 || sem_unlink(group_name) == -1)
		test_perror("cleanup group permission semaphore");
}

static void test_descriptor_exhaustion(void)
{
	enum { MAX_FILLERS = 64 };
	const char *name = "/wasm-sem-emfile-existing";
	const char *new_name = "/wasm-sem-emfile-new";
	struct rlimit original;
	struct rlimit limited;
	int fillers[MAX_FILLERS];
	int count = 0;
	sem_t *sem;
	sem_t *same;
	sem_t *fresh;

	if (getrlimit(RLIMIT_NOFILE, &original) == -1)
		test_perror("getrlimit(RLIMIT_NOFILE)");
	limited = original;
	if (limited.rlim_cur > 32)
		limited.rlim_cur = 32;
	if (setrlimit(RLIMIT_NOFILE, &limited) == -1)
		test_perror("setrlimit(RLIMIT_NOFILE)");

	sem_unlink(name);
	sem_unlink(new_name);
	sem = sem_open(name, O_CREAT | O_EXCL, 0600, 1);
	if (sem == SEM_FAILED)
		test_perror("create descriptor exhaustion semaphore");
	while (count < MAX_FILLERS && (fillers[count] = dup(STDOUT_FILENO)) != -1)
		count++;
	if (count == MAX_FILLERS || errno != EMFILE)
		test_fail("failed to exhaust descriptor table");

	errno = 0;
	if (sem_open(name, 0) != SEM_FAILED || errno != EMFILE)
		test_fail("existing semaphore open ignored descriptor exhaustion");
	errno = 0;
	if (sem_open(new_name, O_CREAT | O_EXCL, 0600, 0) != SEM_FAILED ||
	    errno != EMFILE)
		test_fail("new semaphore open ignored descriptor exhaustion");

	close(fillers[--count]);
	same = sem_open(name, 0);
	if (same == SEM_FAILED || same != sem || sem_close(same) == -1)
		test_fail("existing semaphore was damaged by failed descriptor allocation");
	fresh = sem_open(new_name, O_CREAT | O_EXCL, 0600, 0);
	if (fresh == SEM_FAILED)
		test_perror("create semaphore after descriptor exhaustion");
	if (sem_close(fresh) == -1 || sem_unlink(new_name) == -1)
		test_perror("cleanup descriptor exhaustion replacement");
	while (count)
		close(fillers[--count]);
	if (setrlimit(RLIMIT_NOFILE, &original) == -1 ||
	    sem_close(sem) == -1 || sem_unlink(name) == -1)
		test_perror("cleanup descriptor exhaustion test");
}

int main(int argc, char **argv)
{
	if (argc > 1)
		return child_main(argc, argv);

	test_unnamed_thread_semaphores();
	test_named_wait_cancellation();
	test_concurrent_open_identity();
	test_values_and_overflow();
	test_process_mutex();
	test_process_contention_stress();
	test_linked_persistence_and_getvalue();
	test_wakeup_order();
	test_exclusive_create_race();
	test_unlink_lifetime();
	test_crash_cleanup();
	test_external_unlink_identity();
	test_timedwait_and_interrupt();
	test_permissions();
	test_descriptor_exhaustion();
	test_pass();
}
