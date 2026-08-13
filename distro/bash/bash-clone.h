#ifndef BASH_CLONE_H
#define BASH_CLONE_H

#include <sys/types.h>

pid_t bash_clone (int (*) (void *), void *);

#endif
