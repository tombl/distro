#include "test.h"

#include <stdlib.h>
#include <sys/auxv.h>
#include <unistd.h>

// binfmt_wasm hands userland a flat argument blob instead of the ELF stack, so
// the kernel must synthesise an auxiliary vector immediately past envp[]'s NULL
// terminator, where musl's generic __init_libc walks for one. Before the fix
// that walk stepped into the argument string data: getauxval() returned
// garbage, AT_PAGESZ was absent, and mallocng's startup dereference of a bogus
// AT_RANDOM intermittently trapped, panicking PID 1.
//
// This test asserts the vector is real and correct in the current process, then
// re-execs /init (still PID 1) with a range of argv/env sizes. Those sizes move
// bprm->p's page offset around, which is exactly what made the old fake-auxv
// walk land on trap-inducing bytes for some layouts and not others. A bad auxv
// pointer traps the guest, killing init and panicking the kernel, so every
// phase is a hard assertion: the suite only passes if all layouts start cleanly.

// Pad sizes that step the argument/environment total across byte, word and
// page-offset boundaries.
static const int pad_sizes[] = { 0, 1, 3, 7, 15, 64, 255, 1024, 4093 };
enum { phase_count = (int)(sizeof(pad_sizes) / sizeof(pad_sizes[0])) };

static void verify_startup(void)
{
	unsigned long page = getauxval(AT_PAGESZ);
	long sysconf_page = sysconf(_SC_PAGESIZE);
	unsigned long random_addr;
	volatile unsigned char sink = 0;
	unsigned char *random_bytes;
	unsigned char *block;

	if (page == 0)
		test_fail("getauxval(AT_PAGESZ) returned zero");
	if (sysconf_page <= 0)
		test_perror("sysconf(_SC_PAGESIZE)");
	if (page != (unsigned long)sysconf_page)
		test_fail("AT_PAGESZ disagrees with sysconf(_SC_PAGESIZE)");

	// A bogus AT_RANDOM pointer traps here (out-of-bounds read), which is the
	// original crash the fix prevents.
	random_addr = getauxval(AT_RANDOM);
	if (random_addr == 0)
		test_fail("getauxval(AT_RANDOM) returned zero");
	random_bytes = (unsigned char *)random_addr;
	for (int i = 0; i < 16; i++)
		sink ^= random_bytes[i];
	(void)sink;

	// mallocng seeds itself from AT_RANDOM on first use; exercise it right
	// after startup, which is where the fake-auxv walk used to trap.
	block = malloc(1u << 20);
	if (block == NULL)
		test_fail("malloc failed immediately after startup");
	for (unsigned long i = 0; i < (1u << 20); i++)
		block[i] = (unsigned char)i;
	free(block);
}

static _Noreturn void launch_phase(int phase)
{
	char phase_env[32];
	char *pad;
	char *argv[3];
	char *envp[3];
	int pad_len = pad_sizes[phase];

	// "PAD=" plus NUL-free filler; NUL-free bytes are what the old walk
	// misread as auxv id/value pairs.
	pad = malloc(4 + pad_len + 1);
	if (pad == NULL)
		test_fail("malloc failed building the next argv/env layout");
	memcpy(pad, "PAD=", 4);
	for (int i = 0; i < pad_len; i++)
		pad[4 + i] = 'A';
	pad[4 + pad_len] = '\0';

	snprintf(phase_env, sizeof(phase_env), "AUXV_PHASE=%d", phase);

	argv[0] = "auxv-test";
	argv[1] = "child";
	argv[2] = NULL;

	envp[0] = phase_env;
	envp[1] = pad;
	envp[2] = NULL;

	execve("/init", argv, envp);
	test_perror("execve /init");
}

int main(void)
{
	const char *phase_str = getenv("AUXV_PHASE");
	int phase = phase_str ? atoi(phase_str) : -1;

	verify_startup();

	if (phase + 1 >= phase_count)
		test_pass();

	launch_phase(phase + 1);
}
