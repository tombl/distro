#include <arpa/inet.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void die(const char *operation)
{
	perror(operation);
	exit(1);
}

static unsigned short port(const char *text)
{
	char *end;
	unsigned long value = strtoul(text, &end, 10);
	if (*text == '\0' || *end != '\0' || value == 0 || value > 65535) {
		fprintf(stderr, "invalid port: %s\n", text);
		exit(2);
	}
	return value;
}

static int bind_socket(int type, unsigned short value)
{
	struct sockaddr_in address = {
		.sin_family = AF_INET,
		.sin_port = htons(value),
		.sin_addr.s_addr = htonl(INADDR_ANY),
	};
	int fd = socket(AF_INET, type, 0);
	if (fd < 0)
		die("socket");
	if (bind(fd, (struct sockaddr *)&address, sizeof(address)) < 0)
		die("bind");
	return fd;
}

static void echo_tcp(unsigned short value)
{
	char buffer[4096];
	int listener = bind_socket(SOCK_STREAM, value);
	if (listen(listener, 1) < 0)
		die("listen");
	int fd = accept(listener, NULL, NULL);
	if (fd < 0)
		die("accept");
	for (;;) {
		ssize_t length = read(fd, buffer, sizeof(buffer));
		if (length < 0)
			die("read");
		if (length == 0)
			break;
		if (write(fd, buffer, length) != length)
			die("write");
	}
	close(fd);
	close(listener);
}

static size_t byte_count(const char *text)
{
	char *end;
	unsigned long value = strtoul(text, &end, 10);
	if (*text == '\0' || *end != '\0' || value == 0) {
		fprintf(stderr, "invalid byte count: %s\n", text);
		exit(2);
	}
	return value;
}

static void send_tcp(unsigned short value, size_t length)
{
	unsigned char buffer[4096];
	int listener = bind_socket(SOCK_STREAM, value);
	if (listen(listener, 1) < 0)
		die("listen");
	int fd = accept(listener, NULL, NULL);
	if (fd < 0)
		die("accept");
	int send_buffer = 4096;
	if (setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &send_buffer,
		       sizeof(send_buffer)) < 0)
		die("setsockopt");
	for (size_t offset = 0; offset < length;) {
		size_t chunk = length - offset;
		if (chunk > sizeof(buffer))
			chunk = sizeof(buffer);
		for (size_t index = 0; index < chunk; index++)
			buffer[index] = (offset + index) & 0xff;
		ssize_t written = write(fd, buffer, chunk);
		if (written < 0)
			die("write");
		offset += written;
	}
	close(fd);
	close(listener);
}

static void receive_tcp(unsigned short value, size_t length,
			unsigned int delay_seconds)
{
	unsigned char buffer[4096];
	int listener = bind_socket(SOCK_STREAM, value);
	if (listen(listener, 1) < 0)
		die("listen");
	int fd = accept(listener, NULL, NULL);
	if (fd < 0)
		die("accept");
	sleep(delay_seconds);
	for (size_t offset = 0; offset < length;) {
		size_t chunk = length - offset;
		if (chunk > sizeof(buffer))
			chunk = sizeof(buffer);
		ssize_t received = read(fd, buffer, chunk);
		if (received < 0)
			die("read");
		if (received == 0)
			die("unexpected eof");
		for (ssize_t index = 0; index < received; index++) {
			if (buffer[index] != ((offset + index) & 0xff)) {
				fprintf(stderr, "unexpected byte at offset %zu\n",
					offset + index);
				exit(1);
			}
		}
		offset += received;
	}
	close(fd);
	close(listener);
}

static void echo_udp(unsigned short value)
{
	char buffer[65507];
	struct sockaddr_in peer;
	socklen_t peer_length = sizeof(peer);
	int fd = bind_socket(SOCK_DGRAM, value);
	ssize_t length = recvfrom(fd, buffer, sizeof(buffer), 0,
				  (struct sockaddr *)&peer, &peer_length);
	if (length < 0)
		die("recvfrom");
	if (sendto(fd, buffer, length, 0, (struct sockaddr *)&peer,
		   peer_length) != length)
		die("sendto");
	close(fd);
}

static int connect_tcp(const char *hostname, unsigned short value)
{
	struct addrinfo hints = {
		.ai_family = AF_INET,
		.ai_socktype = SOCK_STREAM,
	};
	struct addrinfo *addresses;
	char service[6];
	snprintf(service, sizeof(service), "%u", value);
	int error = getaddrinfo(hostname, service, &hints, &addresses);
	if (error) {
		fprintf(stderr, "getaddrinfo: %s\n", gai_strerror(error));
		exit(1);
	}
	int fd = socket(addresses->ai_family, addresses->ai_socktype,
			addresses->ai_protocol);
	if (fd < 0)
		die("socket");
	if (connect(fd, addresses->ai_addr, addresses->ai_addrlen) < 0)
		die("connect");
	freeaddrinfo(addresses);
	return fd;
}

static void request(const char *hostname, unsigned short value,
		    const char *message)
{
	char buffer[4096];
	int fd = connect_tcp(hostname, value);
	size_t length = strlen(message);
	size_t received = 0;
	if (write(fd, message, length) != (ssize_t)length)
		die("write");
	while (received < length) {
		ssize_t read_length = read(fd, buffer, sizeof(buffer));
		if (read_length < 0)
			die("read");
		if (read_length == 0)
			die("unexpected eof");
		if (write(STDOUT_FILENO, buffer, read_length) != read_length)
			die("stdout");
		received += read_length;
	}
	close(fd);
}

int main(int argc, char **argv)
{
	if (argc == 4 && strcmp(argv[1], "listen") == 0 &&
	    strcmp(argv[2], "tcp") == 0)
		echo_tcp(port(argv[3]));
	else if (argc == 5 && strcmp(argv[1], "listen") == 0 &&
		 strcmp(argv[2], "tcp") == 0)
		send_tcp(port(argv[3]), byte_count(argv[4]));
	else if (argc == 6 && strcmp(argv[1], "receive") == 0 &&
		 strcmp(argv[2], "tcp") == 0)
		receive_tcp(port(argv[3]), byte_count(argv[4]),
			    byte_count(argv[5]));
	else if (argc == 4 && strcmp(argv[1], "listen") == 0 &&
		 strcmp(argv[2], "udp") == 0)
		echo_udp(port(argv[3]));
	else if (argc == 5 && strcmp(argv[1], "connect") == 0)
		request(argv[2], port(argv[3]), argv[4]);
	else {
		fprintf(stderr,
			"usage: network-test listen tcp PORT [BYTES] | "
			"receive tcp PORT BYTES DELAY_SECONDS | "
			"listen udp PORT | "
			"connect HOST PORT MESSAGE\n");
		return 2;
	}
	return 0;
}
