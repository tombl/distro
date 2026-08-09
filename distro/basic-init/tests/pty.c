#define _GNU_SOURCE

#include "test.h"

#include <fcntl.h>
#include <pty.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static void write_all(int fd, const char *message, size_t size)
{
	ssize_t written = write(fd, message, size);

	if (written == -1)
		test_perror("write PTY");
	if ((size_t)written != size)
		test_fail("short write to PTY");
}

static void expect_read(int fd, const char *expected, size_t size)
{
	char buffer[32];
	ssize_t received = read(fd, buffer, sizeof(buffer));

	if (received == -1)
		test_perror("read PTY");
	if ((size_t)received != size || memcmp(buffer, expected, size) != 0)
		test_fail("unexpected data from PTY");
}

static void configure_raw(int fd)
{
	struct termios settings;

	if (tcgetattr(fd, &settings) == -1)
		test_perror("tcgetattr");
	cfmakeraw(&settings);
	if (tcsetattr(fd, TCSANOW, &settings) == -1)
		test_perror("tcsetattr");
}

static void test_posix_openpt(void)
{
	char *slave_name;
	int master, slave;
	static const char to_slave[] = "master to slave";
	static const char to_master[] = "slave to master";

	master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
	if (master == -1)
		test_perror("posix_openpt");
	if (grantpt(master) == -1)
		test_perror("grantpt");
	if (unlockpt(master) == -1)
		test_perror("unlockpt");
	slave_name = ptsname(master);
	if (slave_name == NULL)
		test_perror("ptsname");
	slave = open(slave_name, O_RDWR | O_NOCTTY | O_CLOEXEC);
	if (slave == -1)
		test_perror("open PTY slave");
	configure_raw(slave);

	write_all(master, to_slave, sizeof(to_slave));
	expect_read(slave, to_slave, sizeof(to_slave));
	write_all(slave, to_master, sizeof(to_master));
	expect_read(master, to_master, sizeof(to_master));

	close(slave);
	close(master);
}

static int acquire_controlling_terminal(void *opaque)
{
	int controlling;
	int slave = *(int *)opaque;

	if (setsid() == -1)
		return 10;
	if (ioctl(slave, TIOCSCTTY, 0) == -1)
		return 11;
	controlling = open("/dev/tty", O_RDWR | O_CLOEXEC);
	if (controlling == -1)
		return 12;
	close(controlling);
	close(slave);
	return 0;
}

static void test_openpty_and_controlling_terminal(void)
{
	const size_t stack_size = 64 * 1024;
	char *stack = malloc(stack_size);
	pid_t child;
	int master, slave, status;

	if (stack == NULL)
		test_perror("malloc clone stack");
	if (openpty(&master, &slave, NULL, NULL, NULL) == -1)
		test_perror("openpty");
	child = clone(acquire_controlling_terminal, stack + stack_size, SIGCHLD,
		      &slave);
	if (child == -1)
		test_perror("clone controlling-terminal child");

	close(slave);
	if (waitpid(child, &status, 0) != child)
		test_perror("waitpid");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
		test_fail("child failed to acquire a controlling terminal");
	close(master);
	free(stack);
}

int main(void)
{
	struct stat device;

	if (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) == -1)
		test_perror("mount devtmpfs");
	if (mkdir("/dev/pts", 0755) == -1 && errno != EEXIST)
		test_perror("mkdir /dev/pts");
	if (mount("devpts", "/dev/pts", "devpts", 0, NULL) == -1)
		test_perror("mount devpts");
	if (stat("/dev/ptmx", &device) == -1 || !S_ISCHR(device.st_mode))
		test_fail("/dev/ptmx is not a character device");

	test_posix_openpt();
	test_openpty_and_controlling_terminal();
	test_pass();
}
