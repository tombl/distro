#include "test.h"

#include <signal.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t alarms;

// Toolchain workaround: a Wasm function pointer is an __indirect_function_table
// index, and wasm-ld hands out the low slots to whichever functions have their
// address taken first. Slot 1 collides with SIG_IGN(1), so a handler that lands
// there is misread by the kernel as "ignore" and never runs. Take five dummies'
// addresses before on_alarm's so the dummies fill the low slots and on_alarm
// lands past 1; this exercises real signal delivery, not the sentinel clash.
typedef void (*handler_t)(int);
static void dummy0(int s) { (void)s; }
static void dummy1(int s) { (void)s; }
static void dummy2(int s) { (void)s; }
static void dummy3(int s) { (void)s; }
static void dummy4(int s) { (void)s; }
static handler_t volatile sink[5];

static void on_alarm(int sig)
{
	(void)sig;
	alarms++;
}

int main(void)
{
	// See the note above: address-take the dummies before on_alarm.
	sink[0] = dummy0;
	sink[1] = dummy1;
	sink[2] = dummy2;
	sink[3] = dummy3;
	sink[4] = dummy4;
	for (int i = 0; i < 5; i++)
		sink[i](0);

	struct sigaction sa = { 0 };
	sa.sa_handler = on_alarm;
	printf("timer: on_alarm=%p sink0=%p\n", (void *)on_alarm,
	       (void *)sink[0]);
	fflush(stdout);
	if (sigaction(SIGALRM, &sa, NULL) == -1)
		test_perror("sigaction");

	// Scenario 1: setitimer(ITIMER_REAL) must interrupt a blocking sleep.
	struct itimerval it = { 0 };
	it.it_value.tv_usec = 200 * 1000; // 200ms one-shot
	if (setitimer(ITIMER_REAL, &it, NULL) == -1)
		test_perror("setitimer");

	printf("timer: armed setitimer, sleeping\n");
	fflush(stdout);

	struct timespec req = { .tv_sec = 2, .tv_nsec = 0 };
	int ret = nanosleep(&req, NULL);
	printf("timer: nanosleep returned %d errno=%d alarms=%d\n", ret, errno,
	       (int)alarms);
	fflush(stdout);

	if (alarms < 1)
		test_fail("setitimer: SIGALRM handler never ran");
	if (ret != -1)
		test_fail("setitimer: nanosleep was not interrupted");

	// Scenario 2: alarm() while runnable (busy loop, no syscall sleeping).
	alarms = 0;
	alarm(1);
	printf("timer: armed alarm(1), busy-looping\n");
	fflush(stdout);
	time_t start = time(NULL);
	while (alarms < 1) {
		if (time(NULL) - start > 5)
			test_fail("alarm: SIGALRM never fired while runnable");
	}
	printf("timer: alarm fired while runnable\n");
	fflush(stdout);

	// Scenario 3: POSIX per-process one-shot timer_create.
	alarms = 0;
	timer_t tid;
	struct sigevent sev = { 0 };
	sev.sigev_notify = SIGEV_SIGNAL;
	sev.sigev_signo = SIGALRM;
	if (timer_create(CLOCK_MONOTONIC, &sev, &tid) == -1)
		test_perror("timer_create");
	struct itimerspec its = { 0 };
	its.it_value.tv_nsec = 200 * 1000 * 1000; // 200ms one-shot
	if (timer_settime(tid, 0, &its, NULL) == -1)
		test_perror("timer_settime");
	printf("timer: armed timer_create, sleeping\n");
	fflush(stdout);
	req.tv_sec = 2;
	req.tv_nsec = 0;
	ret = nanosleep(&req, NULL);
	printf("timer: timer_create nanosleep returned %d alarms=%d\n", ret,
	       (int)alarms);
	fflush(stdout);
	if (alarms < 1)
		test_fail("timer_create: SIGALRM handler never ran");

	test_pass();
}
