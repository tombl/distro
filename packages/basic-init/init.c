#include <sched.h>
#include <stdio.h>
#include <sys/utsname.h>
#include <unistd.h>

int main(void)
{
	struct utsname system;

	printf("hello from pid %d\n", getpid());
	if (uname(&system) == 0)
		printf("%s %s %s\n", system.sysname, system.release,
		       system.machine);
	else
		perror("uname");

	for (;;)
		sched_yield();
}
