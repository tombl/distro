#define _GNU_SOURCE

#include "test.h"

#include <fcntl.h>
#include <pthread.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static int wait_one(int epoll_fd, int timeout, struct epoll_event *event)
{
	int ready = epoll_wait(epoll_fd, event, 1, timeout);

	if (ready == -1)
		test_perror("epoll_wait");
	return ready;
}

static void add(int epoll_fd, int fd, uint32_t events)
{
	struct epoll_event event = { .events = events, .data.fd = fd };

	if (epoll_ctl(epoll_fd, EPOLL_CTL_ADD, fd, &event) == -1)
		test_perror("epoll_ctl(ADD)");
}

static long elapsed_ms(const struct timespec *start)
{
	struct timespec now;

	clock_gettime(CLOCK_MONOTONIC, &now);
	return (now.tv_sec - start->tv_sec) * 1000 +
	       (now.tv_nsec - start->tv_nsec) / 1000000;
}

static void test_pipe_level_and_hangup(void)
{
	struct epoll_event event;
	struct timespec start;
	int epoll_fd, pipe_fds[2];
	char byte;

	epoll_fd = epoll_create1(EPOLL_CLOEXEC);
	if (epoll_fd == -1)
		test_perror("epoll_create1");
	if (pipe2(pipe_fds, O_CLOEXEC) == -1)
		test_perror("pipe2");
	add(epoll_fd, pipe_fds[0], EPOLLIN);

	clock_gettime(CLOCK_MONOTONIC, &start);
	if (wait_one(epoll_fd, 100, &event) != 0)
		test_fail("empty pipe reported ready");
	if (elapsed_ms(&start) < 90)
		test_fail("epoll_wait timed out early");

	if (write(pipe_fds[1], "x", 1) != 1)
		test_perror("write pipe");
	/* Level-triggered: the unread byte keeps the descriptor ready. */
	for (int i = 0; i < 2; i++) {
		if (wait_one(epoll_fd, 0, &event) != 1 ||
		    event.data.fd != pipe_fds[0] || !(event.events & EPOLLIN))
			test_fail("readable pipe not reported");
	}
	if (read(pipe_fds[0], &byte, 1) != 1)
		test_perror("read pipe");
	if (wait_one(epoll_fd, 0, &event) != 0)
		test_fail("drained pipe still reported ready");

	close(pipe_fds[1]);
	if (wait_one(epoll_fd, 0, &event) != 1 || !(event.events & EPOLLHUP))
		test_fail("closed writer did not report EPOLLHUP");

	close(pipe_fds[0]);
	close(epoll_fd);
}

static void test_socket_edge_triggered(void)
{
	struct epoll_event event;
	int epoll_fd, sockets[2];
	char buffer[4];

	epoll_fd = epoll_create1(EPOLL_CLOEXEC);
	if (epoll_fd == -1)
		test_perror("epoll_create1");
	if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets) == -1)
		test_perror("socketpair");
	add(epoll_fd, sockets[1], EPOLLIN | EPOLLET);

	if (write(sockets[0], "ab", 2) != 2)
		test_perror("write socket");
	if (wait_one(epoll_fd, 0, &event) != 1 || event.data.fd != sockets[1])
		test_fail("edge-triggered socket not reported");
	/* Edge-triggered: no new data, no new event, even though bytes remain. */
	if (wait_one(epoll_fd, 0, &event) != 0)
		test_fail("edge-triggered socket reported twice");
	if (write(sockets[0], "c", 1) != 1)
		test_perror("write socket");
	if (wait_one(epoll_fd, 0, &event) != 1)
		test_fail("second edge not reported");
	if (read(sockets[1], buffer, sizeof(buffer)) != 3)
		test_fail("socket did not hold both writes");

	close(sockets[0]);
	close(sockets[1]);
	close(epoll_fd);
}

static void *write_later(void *arg)
{
	int fd = *(int *)arg;
	struct timespec delay = { .tv_nsec = 50 * 1000 * 1000 };

	nanosleep(&delay, NULL);
	if (write(fd, "w", 1) != 1)
		test_perror("write from thread");
	return NULL;
}

static void test_wake_from_thread(void)
{
	struct epoll_event event;
	struct timespec start;
	pthread_t thread;
	int epoll_fd, pipe_fds[2];

	epoll_fd = epoll_create1(EPOLL_CLOEXEC);
	if (epoll_fd == -1)
		test_perror("epoll_create1");
	if (pipe2(pipe_fds, O_CLOEXEC) == -1)
		test_perror("pipe2");
	add(epoll_fd, pipe_fds[0], EPOLLIN);

	if (pthread_create(&thread, NULL, write_later, &pipe_fds[1]) != 0)
		test_fail("pthread_create");
	/* Blocks until the other thread, in another worker, writes. */
	clock_gettime(CLOCK_MONOTONIC, &start);
	if (wait_one(epoll_fd, 5000, &event) != 1 || event.data.fd != pipe_fds[0])
		test_fail("blocking epoll_wait was not woken by another thread");
	if (elapsed_ms(&start) > 2000)
		test_fail("epoll_wait woke long after the other thread wrote");
	pthread_join(thread, NULL);

	close(pipe_fds[0]);
	close(pipe_fds[1]);
	close(epoll_fd);
}

int main(void)
{
	test_pipe_level_and_hangup();
	test_socket_edge_triggered();
	test_wake_from_thread();
	test_pass();
}
