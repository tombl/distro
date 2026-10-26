#define _GNU_SOURCE

#include "test.h"

#include <stdint.h>
#include <sys/socket.h>
#include <linux/vm_sockets.h>
#include <unistd.h>

/* The vm-test runner echoes guest connections on this port. */
#define ECHO_PORT 7
#define UNBOUND_PORT 9
#define BULK_SIZE (128 * 1024)

static int vsock_connect(unsigned int port)
{
	struct sockaddr_vm addr = {
		.svm_family = AF_VSOCK,
		.svm_cid = VMADDR_CID_HOST,
		.svm_port = port,
	};
	int fd = socket(AF_VSOCK, SOCK_STREAM, 0);

	if (fd == -1)
		test_perror("socket(AF_VSOCK)");
	if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == -1) {
		int saved = errno;

		close(fd);
		errno = saved;
		return -1;
	}
	return fd;
}

static void write_all(int fd, const void *data, size_t size)
{
	const char *cursor = data;

	while (size > 0) {
		ssize_t written = write(fd, cursor, size);

		if (written == -1)
			test_perror("write(vsock)");
		cursor += written;
		size -= (size_t)written;
	}
}

static void read_exactly(int fd, void *data, size_t size)
{
	char *cursor = data;

	while (size > 0) {
		ssize_t received = read(fd, cursor, size);

		if (received == -1)
			test_perror("read(vsock)");
		if (received == 0)
			test_fail("unexpected end of stream");
		cursor += received;
		size -= (size_t)received;
	}
}

static void expect_echo(int fd, const char *message)
{
	size_t size = strlen(message);
	char buffer[64];

	write_all(fd, message, size);
	read_exactly(fd, buffer, size);
	if (memcmp(buffer, message, size) != 0)
		test_fail("echoed data does not match");
}

static void test_roundtrip(void)
{
	int fd = vsock_connect(ECHO_PORT);

	if (fd == -1)
		test_perror("connect(echo)");
	expect_echo(fd, "hello vsock");
	close(fd);
}

/* Two live connections to one port must not share a stream. */
static void test_concurrent_connections(void)
{
	int first = vsock_connect(ECHO_PORT);
	int second = vsock_connect(ECHO_PORT);

	if (first == -1 || second == -1)
		test_perror("connect(echo)");
	write_all(first, "one", 3);
	write_all(second, "two", 3);

	char buffer[3];

	read_exactly(second, buffer, 3);
	if (memcmp(buffer, "two", 3) != 0)
		test_fail("second connection lost its stream position");
	read_exactly(first, buffer, 3);
	if (memcmp(buffer, "one", 3) != 0)
		test_fail("first connection lost its stream position");
	expect_echo(second, "second connection");
	expect_echo(first, "first connection");
	close(second);
	close(first);
}

/*
 * A transfer larger than one vsock packet exercises chunking and credit
 * updates in both directions, and shutdown(SHUT_WR) must drain the echo
 * and then deliver end of stream once the host closes its side.
 */
static void test_bulk_and_half_close(void)
{
	static uint8_t data[BULK_SIZE], echoed[BULK_SIZE];
	int fd = vsock_connect(ECHO_PORT);
	char extra;

	if (fd == -1)
		test_perror("connect(echo)");
	for (size_t i = 0; i < BULK_SIZE; i++)
		data[i] = (uint8_t)(i ^ (i >> 8));
	write_all(fd, data, BULK_SIZE);
	read_exactly(fd, echoed, BULK_SIZE);
	if (memcmp(data, echoed, BULK_SIZE) != 0)
		test_fail("bulk echo does not match");
	if (shutdown(fd, SHUT_WR) == -1)
		test_perror("shutdown(SHUT_WR)");
	if (read(fd, &extra, 1) != 0)
		test_fail("expected end of stream after shutdown");
	close(fd);
}

/* Ports nothing listens on must refuse immediately, not time out. */
static void test_unbound_port(void)
{
	int fd = vsock_connect(UNBOUND_PORT);

	if (fd != -1)
		test_fail("connect to an unbound port succeeded");
	if (errno != ECONNRESET)
		test_perror("connect(unbound)");
}

int main(void)
{
	test_roundtrip();
	test_concurrent_connections();
	test_bulk_and_half_close();
	test_unbound_port();
	test_pass();
}
