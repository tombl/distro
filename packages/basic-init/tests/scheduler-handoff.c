#include "test.h"

#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>

#define WORKERS 4
#define YIELDS_PER_WORKER 5000

static pthread_barrier_t start;
static _Atomic unsigned int yields;

static void *worker(void *unused) {
  int status;

  (void)unused;
  status = pthread_barrier_wait(&start);
  if (status != 0 && status != PTHREAD_BARRIER_SERIAL_THREAD)
    test_fail("waiting at scheduler handoff barrier");

  for (int i = 0; i < YIELDS_PER_WORKER; i++) {
    atomic_fetch_add(&yields, 1);
    sched_yield();
  }
  return NULL;
}

int main(void) {
  pthread_t workers[WORKERS];

  if (pthread_barrier_init(&start, NULL, WORKERS) != 0)
    test_fail("initializing scheduler handoff barrier");
  for (int i = 0; i < WORKERS; i++)
    if (pthread_create(&workers[i], NULL, worker, NULL) != 0)
      test_fail("creating scheduler handoff worker");
  for (int i = 0; i < WORKERS; i++)
    if (pthread_join(workers[i], NULL) != 0)
      test_fail("joining scheduler handoff worker");
  if (atomic_load(&yields) != WORKERS * YIELDS_PER_WORKER)
    test_fail("scheduler handoff worker stopped early");
  if (pthread_barrier_destroy(&start) != 0)
    test_fail("destroying scheduler handoff barrier");

  test_pass();
}
