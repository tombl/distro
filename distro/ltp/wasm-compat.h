/*
 * Force-included into every LTP translation unit (see package.nix).
 *
 * The package builds the whole tst_test library, but its curated syscall tests
 * reach only a slice of it. The rest will not *compile* because this target's
 * musl hides the fork() and mmap() families behind `#ifndef __wasm__` (there is
 * no fork and no mmap here), so every source that still references them fails
 * with "call to undeclared function" before the linker is ever reached.
 *
 * Re-declare exactly those functions so the dead code compiles. Nothing is
 * *defined*: fork and mmap remain undefined in libc, so any reference that
 * survives wasm-ld's dead-code elimination becomes a link error naming the
 * precise function a future test needs ported. The handful of live references
 * are ported off these calls in forkless-library.patch.
 */
#ifndef LTP_WASM_COMPAT_H
#define LTP_WASM_COMPAT_H

#include <sys/types.h>
#include <stddef.h>

/*
 * The mmap-family flag macros live behind the same __wasm__ guard as the
 * functions, so re-provide the ones the (dead) library code names. The values
 * are the usual Linux ones for hygiene only; nothing here executes.
 */
#ifndef PROT_NONE
#define PROT_NONE 0
#define PROT_READ 1
#define PROT_WRITE 2
#define PROT_EXEC 4
#endif
#ifndef MAP_SHARED
#define MAP_SHARED 0x01
#define MAP_PRIVATE 0x02
#define MAP_FIXED 0x10
#define MAP_ANONYMOUS 0x20
#define MAP_POPULATE 0x8000
#endif
#ifndef MAP_FAILED
#define MAP_FAILED ((void *)-1)
#endif
#ifndef MS_SYNC
#define MS_ASYNC 1
#define MS_INVALIDATE 2
#define MS_SYNC 4
#endif

void *mmap(void *, size_t, int, int, int, off_t);
int munmap(void *, size_t);
int mprotect(void *, size_t, int);
int msync(void *, size_t, int);
int mlock(const void *, size_t);
int munlock(const void *, size_t);
int mincore(void *, size_t, unsigned char *);

pid_t fork(void);
pid_t vfork(void);

#endif
