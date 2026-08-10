#define _GNU_SOURCE

#include "test.h"

#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static void write_all(int fd, const void *data, size_t size, const char *operation)
{
	ssize_t written = write(fd, data, size);

	if (written == -1)
		test_perror(operation);
	if ((size_t)written != size)
		test_fail("short write");
}

static void expect_read(int fd, const void *expected, size_t size,
			const char *operation)
{
	char buffer[32];
	ssize_t received = read(fd, buffer, sizeof(buffer));

	if (received == -1)
		test_perror(operation);
	if ((size_t)received != size || memcmp(buffer, expected, size) != 0)
		test_fail("unexpected socket data");
}

static void test_eventfd(void)
{
	eventfd_t value;
	int fd = eventfd(0, EFD_CLOEXEC);

	if (fd == -1)
		test_perror("eventfd");
	if (eventfd_write(fd, 4) == -1 || eventfd_write(fd, 7) == -1)
		test_perror("eventfd_write");
	if (eventfd_read(fd, &value) == -1)
		test_perror("eventfd_read");
	if (value != 11)
		test_fail("eventfd counter did not accumulate writes");
	close(fd);
}

static void test_socketpair(int type)
{
	static const char message[] = "socketpair";
	int sockets[2];

	if (socketpair(AF_UNIX, type | SOCK_CLOEXEC, 0, sockets) == -1)
		test_perror("socketpair(AF_UNIX)");
	write_all(sockets[0], message, sizeof(message), "write socketpair");
	expect_read(sockets[1], message, sizeof(message), "read socketpair");
	close(sockets[0]);
	close(sockets[1]);
}

static void test_path_socket(void)
{
	static const char request[] = "request";
	static const char response[] = "response";
	struct sockaddr_un address = {
		.sun_family = AF_UNIX,
		.sun_path = "/tmp/platform-unix.sock",
	};
	int listener, client, server;

	listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (listener == -1)
		test_perror("socket(AF_UNIX)");
	unlink(address.sun_path);
	if (bind(listener, (struct sockaddr *)&address, sizeof(address)) == -1)
		test_perror("bind(AF_UNIX)");
	if (listen(listener, 1) == -1)
		test_perror("listen(AF_UNIX)");
	client = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (client == -1)
		test_perror("client socket(AF_UNIX)");
	if (connect(client, (struct sockaddr *)&address, sizeof(address)) == -1)
		test_perror("connect(AF_UNIX)");
	server = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
	if (server == -1)
		test_perror("accept4(AF_UNIX)");

	write_all(client, request, sizeof(request), "write AF_UNIX request");
	expect_read(server, request, sizeof(request), "read AF_UNIX request");
	write_all(server, response, sizeof(response), "write AF_UNIX response");
	expect_read(client, response, sizeof(response), "read AF_UNIX response");

	close(server);
	close(client);
	close(listener);
	unlink(address.sun_path);
}

static void test_scm_rights(void)
{
	char control[CMSG_SPACE(sizeof(int))];
	char payload = 'f';
	struct iovec iov = { .iov_base = &payload, .iov_len = sizeof(payload) };
	struct msghdr message = {
		.msg_iov = &iov,
		.msg_iovlen = 1,
		.msg_control = control,
		.msg_controllen = sizeof(control),
	};
	struct cmsghdr *header;
	int sockets[2], pipe_fds[2], received_fd;
	static const char pipe_message[] = "passed descriptor";

	if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sockets) == -1)
		test_perror("socketpair for SCM_RIGHTS");
	if (pipe2(pipe_fds, O_CLOEXEC) == -1)
		test_perror("pipe2 for SCM_RIGHTS");
	header = CMSG_FIRSTHDR(&message);
	header->cmsg_level = SOL_SOCKET;
	header->cmsg_type = SCM_RIGHTS;
	header->cmsg_len = CMSG_LEN(sizeof(int));
	memcpy(CMSG_DATA(header), &pipe_fds[0], sizeof(pipe_fds[0]));
	if (sendmsg(sockets[0], &message, 0) != sizeof(payload))
		test_perror("sendmsg(SCM_RIGHTS)");

	memset(control, 0, sizeof(control));
	message.msg_controllen = sizeof(control);
	if (recvmsg(sockets[1], &message, 0) != sizeof(payload))
		test_perror("recvmsg(SCM_RIGHTS)");
	header = CMSG_FIRSTHDR(&message);
	if (header == NULL || header->cmsg_level != SOL_SOCKET ||
	    header->cmsg_type != SCM_RIGHTS || header->cmsg_len != CMSG_LEN(sizeof(int)))
		test_fail("invalid SCM_RIGHTS control message");
	memcpy(&received_fd, CMSG_DATA(header), sizeof(received_fd));

	write_all(pipe_fds[1], pipe_message, sizeof(pipe_message),
		  "write passed descriptor");
	expect_read(received_fd, pipe_message, sizeof(pipe_message),
		    "read passed descriptor");

	close(received_fd);
	close(pipe_fds[0]);
	close(pipe_fds[1]);
	close(sockets[0]);
	close(sockets[1]);
}

int main(void)
{
	test_eventfd();
	test_socketpair(SOCK_STREAM);
	test_socketpair(SOCK_SEQPACKET);
	test_path_socket();
	test_scm_rights();
	test_pass();
}
