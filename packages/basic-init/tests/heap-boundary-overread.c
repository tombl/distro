#define _DEFAULT_SOURCE
#include "test.h"

#include <stdint.h>
#include <string.h>
#include <unistd.h>

// Regression test for the intermittent "memory access out of bounds" trap that
// GNU coreutils hit (wc -l, tail -n, readlink, df, cat). Those tools perform a
// latent over-read a few bytes past a heap buffer -- harmless on a page-granular
// OS because the rest of the mapped page absorbs it, but faulting under wasm's
// exact linear-memory bound when the buffer abuts the top of memory.
//
// On this platform malloc obtains memory from sbrk (arch/wasm32 has no mmap),
// which packs allocations directly against the program break. When the break
// lands on a 64KiB wasm-memory boundary, the top allocation abuts unbacked
// memory with zero slack and any over-read faults. The fix keeps a guard of
// backed memory past the break (src/linux/brk.c) so a bounded over-read always
// lands in backed memory, reproducing the page-granular read slack that C
// programs universally rely on.
//
// This test forces that boundary condition deterministically (no reliance on
// the intermittency) and asserts the guard invariant holds.

enum {
	wasm_page = 64 * 1024,
	// A generous bound on the kind of over-read GNU tools perform near a
	// buffer end (word-at-a-time / small vector scans).
	overread_bytes = 64,
};

static uintptr_t memory_limit(void)
{
	return (uintptr_t)__builtin_wasm_memory_size(0) * wasm_page;
}

// Drive the program break exactly onto the current memory boundary, then
// over-read past it the way a boundary-abutting coreutils buffer does. Returns
// with the reads completed; a broken allocator traps inside here instead.
static void probe_boundary_overread(void)
{
	uintptr_t cur = (uintptr_t)sbrk(0);
	if (cur == (uintptr_t)-1)
		test_perror("sbrk(0)");

	uintptr_t limit = memory_limit();
	if (sbrk((intptr_t)(limit - cur)) == (void *)-1)
		test_perror("sbrk to memory boundary");

	uintptr_t brk = (uintptr_t)sbrk(0);

	// The guard invariant: after the break reaches a memory boundary the
	// allocator must have grown memory so backed bytes remain past the break.
	if (memory_limit() <= brk)
		test_fail("no guard headroom: backed memory ends at the program break");

	// A buffer whose data ends exactly at the break, over-read one word-ish
	// span past its end. Every byte read here is past the break; it must be
	// backed by the guard, not trap.
	volatile unsigned char *buf = (volatile unsigned char *)(brk - overread_bytes);
	memset((void *)buf, 'x', overread_bytes);
	volatile unsigned long acc = 0;
	for (int i = 0; i < overread_bytes; i++)
		acc += buf[overread_bytes + i];
	(void)acc;
}

int main(void)
{
	// A handful of intervening allocations shift where subsequent breaks land,
	// so the boundary probe covers several starting offsets.
	for (int round = 0; round < 8; round++) {
		volatile char *filler = sbrk(round * 37);
		if (filler != (void *)-1)
			memset((void *)filler, 0, (size_t)(round * 37));
		probe_boundary_overread();
	}

	test_pass();
}
