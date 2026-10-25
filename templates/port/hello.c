#include <stdio.h>
#include <sys/utsname.h>

int main(void) {
  struct utsname name;
  if (uname(&name) != 0) {
    perror("uname");
    return 1;
  }
  printf("Hello from %s on %s!\n", name.sysname, name.machine);
  return 0;
}
