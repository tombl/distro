#define _GNU_SOURCE
#include <stdlib.h>
#include <sched.h>
#include <stdio.h>
#include <sys/utsname.h>
#include <unistd.h>

static int foo = 0;

int other(void *arg) {
        printf("hello from other thread: %d\n", foo);
        return 0;
}

int main(int argc, char *argv[], char *envp[]) {
        printf("Hello, world!\n");

        printf("pid = %d\n", getpid());

        struct utsname sysinfo;
        if (uname(&sysinfo) == -1) {
                perror("uname");
                return 1;
        }

        printf("%s %s %s\n", sysinfo.sysname, sysinfo.release, sysinfo.version);

        printf("argc = %d\n", argc);
        for (int i = 0; i < argc; i++)
                printf("argv[%d] = %s\n", i, argv[i]);
        for (int i = 0; envp[i]; i++)
                printf("envp[%d] = %s\n", i, envp[i]);

        foo = 1;
        void* stack = malloc(4096);
        if (!stack) {
                perror("malloc");
                return 1;
        }

        if (clone(other, stack + 4096, CLONE_VM | CLONE_VFORK, NULL) == -1) {
                perror("clone");
                return 1;
        }

        free(stack);

        printf("idling forever\n");
        for (;;)
                sched_yield();

        return 0;
}