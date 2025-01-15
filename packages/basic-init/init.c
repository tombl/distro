#include <sched.h>
#include <stdio.h>
#include <sys/utsname.h>
#include <unistd.h>

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

        printf("idling forever\n");
        for (;;)
                sched_yield();

        return 0;
}