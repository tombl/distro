/* Minimal inetd-style superserver for the dropbear VM check.
 *
 * The guest has no fork(), so busybox's `nc -l -e` and friends cannot be relied
 * on to launch a per-connection server. This fixture does the one thing the
 * server side needs: accept a TCP connection on 127.0.0.1:<port>, then
 * posix_spawn <prog> with the connected socket wired to its stdin and stdout
 * (dropbear -i speaks the SSH transport over fd 0/1; fd 2 stays on our stderr so
 * its -E logging is visible). It loops forever, serving connections serially, so
 * one instance backs both the positive and the negative auth checks.
 *
 * usage: tcp-spawn <port> <ready-file> <prog> [args...]
 *
 * After bind()+listen() succeeds it creates <ready-file>, which the test script
 * waits for before starting the client -- avoiding a connect-before-listen race
 * without relying on timers (SIGALRM does not fire on the guest kernel).
 */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static void die(const char *msg) {
	perror(msg);
	exit(1);
}

int main(int argc, char **argv) {
	if (argc < 4) {
		fprintf(stderr, "usage: %s <port> <ready-file> <prog> [args...]\n", argv[0]);
		return 2;
	}

	int port = atoi(argv[1]);
	const char *readyfile = argv[2];
	char **child_argv = &argv[3];

	int lsock = socket(AF_INET, SOCK_STREAM, 0);
	if (lsock < 0) {
		die("tcp-spawn: socket");
	}
	int one = 1;
	setsockopt(lsock, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

	struct sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons(port);
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	if (bind(lsock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		die("tcp-spawn: bind");
	}
	if (listen(lsock, 8) < 0) {
		die("tcp-spawn: listen");
	}

	/* Signal readiness to the test script. */
	FILE *rf = fopen(readyfile, "w");
	if (rf == NULL) {
		die("tcp-spawn: fopen ready-file");
	}
	fclose(rf);
	fprintf(stderr, "tcp-spawn: listening on 127.0.0.1:%d\n", port);

	for (;;) {
		int conn = accept(lsock, NULL, NULL);
		if (conn < 0) {
			die("tcp-spawn: accept");
		}

		posix_spawn_file_actions_t fa;
		posix_spawn_file_actions_init(&fa);
		posix_spawn_file_actions_adddup2(&fa, conn, STDIN_FILENO);
		posix_spawn_file_actions_adddup2(&fa, conn, STDOUT_FILENO);
		posix_spawn_file_actions_addclose(&fa, conn);

		pid_t pid;
		int rc = posix_spawn(&pid, child_argv[0], &fa, NULL, child_argv, environ);
		posix_spawn_file_actions_destroy(&fa);
		close(conn);

		if (rc != 0) {
			fprintf(stderr, "tcp-spawn: posix_spawn %s failed: %s\n",
				child_argv[0], strerror(rc));
			continue;
		}

		int status;
		if (waitpid(pid, &status, 0) < 0) {
			die("tcp-spawn: waitpid");
		}
		fprintf(stderr, "tcp-spawn: child exited (status %d)\n", status);
	}
}
