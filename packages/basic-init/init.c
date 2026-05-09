#define _GNU_SOURCE
#include <stdlib.h>
#include <sched.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdint.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/utsname.h>
#include <unistd.h>
#include <string.h>

static int foo = 0;
static char proc_mem_probe[] = "proc-self-mem-probe";

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

        if (mkdir("/proc", 0555) == -1 && errno != EEXIST) {
                perror("mkdir /proc");
                return 1;
        }

        if (mount("proc", "/proc", "proc", 0, NULL) == -1 && errno != EBUSY) {
                perror("mount proc");
                return 1;
        }

        int memfd = open("/proc/self/mem", O_RDONLY);
        if (memfd == -1) {
                perror("open /proc/self/mem");
                return 1;
        }

        char mem_probe_buf[sizeof(proc_mem_probe)] = {0};
        if (lseek(memfd, (off_t)(uintptr_t)proc_mem_probe, SEEK_SET) == (off_t)-1) {
                perror("lseek /proc/self/mem");
                return 1;
        }

        ssize_t mem_probe_len = read(memfd, mem_probe_buf, sizeof(mem_probe_buf));
        if (mem_probe_len == -1) {
                perror("read /proc/self/mem");
                return 1;
        }

        printf("proc self mem read len=%zd value='%s' expected='%s'\n",
               mem_probe_len, mem_probe_buf, proc_mem_probe);

        if (mem_probe_len != sizeof(proc_mem_probe) ||
            memcmp(mem_probe_buf, proc_mem_probe, sizeof(proc_mem_probe)) != 0) {
                fprintf(stderr, "incorrect /proc/self/mem read\n");
                return 1;
        }

        close(memfd);

        printf("idling forever\n");
        for (;;)
                sched_yield();

        return 0;
}
