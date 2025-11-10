#define _GNU_SOURCE
#include <stdlib.h>
#include <sched.h>
#include <stdio.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <unistd.h>
#include <string.h>

static int foo = 0;

int other(void *arg) {
        printf("hello from other thread: %d\n", foo);
        exit(1);
        return 0;
}

int main(int argc, char *argv[]) {
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
        for (int i = 0; environ[i]; i++)
                printf("environ[%d] = %s\n", i, environ[i]);

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

        if (mkdir("/foo", 0755) == -1) {
                perror("mkdir");
                return 1;
        }

        if (chdir("/foo") == -1) {
                perror("chdir");
                return 1;
        }

        char *cwd = getcwd(NULL, 0);
        if (!cwd) {
                perror("getcwd");
                return 1;
        }
        printf("cwd = %s\n", cwd);

        if (strcmp(cwd, "/foo") != 0) {
                fprintf(stderr, "incorrect cwd: chdir is broken");
                return 1;
        }
        
        free(cwd);

        printf("idling forever\n");
        for (;;)
                sched_yield();

        return 0;
}
