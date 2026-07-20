#define _GNU_SOURCE

#include <fcntl.h>
#include <linux/tty.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <unistd.h>

static int framebuffer_shell(void *arg)
{
	int tty;
	char *argv[] = { "/bin/busybox", "sh", NULL };

	(void)arg;
	setsid();
	tty = open("/dev/tty0", O_RDWR);
	if (tty == -1) {
		perror("open /dev/tty0");
		_exit(127);
	}

	if (ioctl(tty, TIOCSCTTY, 0) == -1)
		perror("ioctl TIOCSCTTY");
	if (dup2(tty, STDIN_FILENO) == -1)
		perror("dup2 tty stdin");
	if (dup2(tty, STDOUT_FILENO) == -1)
		perror("dup2 tty stdout");
	if (dup2(tty, STDERR_FILENO) == -1)
		perror("dup2 tty stderr");
	if (tty > STDERR_FILENO)
		close(tty);

	setenv("TERM", "linux", 1);
	puts("\nwasm-linux framebuffer shell\n");
	execve(argv[0], argv, environ);
	perror("execve framebuffer shell");
	_exit(127);
}

static void spawn_framebuffer_shell(uint8_t *stack, size_t stack_len)
{
	struct stat st;
	pid_t pid;

	if (stat("/dev/tty0", &st) == -1 || !S_ISCHR(st.st_mode))
		return;

	pid = clone(framebuffer_shell, stack + stack_len, SIGCHLD, NULL);
	if (pid == -1) {
		perror("clone framebuffer shell");
		return;
	}

	fprintf(stderr, "basic-init: framebuffer shell pid %d on /dev/tty0\n",
		pid);
}

int main(void)
{
	uint8_t framebuffer_shell_stack[16 * 1024];
	struct utsname system;

	spawn_framebuffer_shell(framebuffer_shell_stack,
				sizeof(framebuffer_shell_stack));
	printf("hello from pid %d\n", getpid());
	if (uname(&system) == 0)
		printf("%s %s %s\n", system.sysname, system.release,
		       system.machine);
	else
		perror("uname");

	for (;;)
		sched_yield();
}
