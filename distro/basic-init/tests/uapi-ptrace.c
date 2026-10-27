#include "test.h"

#include <linux/bpf_perf_event.h>
#include <linux/ptrace.h>

/*
 * The installed <asm/ptrace.h> must build in userspace and provide
 * struct pt_regs, as tracers and BPF tools expect.
 */
int main(void)
{
	struct pt_regs regs = { .syscall_nr = PTRACE_SYSEMU };
	bpf_user_pt_regs_t *view = &regs;

	if (view->syscall_nr != 31 || PTRACE_SYSEMU_SINGLESTEP != 32)
		test_fail("unexpected ptrace UAPI values");
	test_pass();
}
