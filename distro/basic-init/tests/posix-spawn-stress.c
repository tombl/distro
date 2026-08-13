#define _GNU_SOURCE

#include "test.h"

#include <pthread.h>
#include <spawn.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

enum {
	iterations = 256,
	growth_bytes = 16 * 1024 * 1024,
	environment_count = 32,
	environment_value_bytes = 2048,
};

struct spawn_context {
	char *environment[environment_count + 1];
	char *path;
	char *cwd;
	char *growth;
	pthread_mutex_t mutex;
	pthread_cond_t condition;
	int memory_ready;
};

static void *spawn_stress(void *argument)
{
	struct spawn_context *context = argument;

	/* The InitMessage carrying this worker's memory is posted before the main
	 * worker grows it. Waiting here also makes the old wrapper observable
	 * before any high-memory pathname or environment pointer is consumed. */
	if (pthread_mutex_lock(&context->mutex))
		test_fail("lock spawn readiness mutex");
	while (!context->memory_ready)
		if (pthread_cond_wait(&context->condition, &context->mutex))
			test_fail("wait for grown user memory");
	if (pthread_mutex_unlock(&context->mutex))
		test_fail("unlock spawn readiness mutex");

	for (int i = 0; i < iterations; i++) {
		char *argv[] = { context->path, "--child", NULL };
		posix_spawn_file_actions_t actions;
		pid_t pid;
		int error;
		int actions_initialized;
		int status;

		error = posix_spawn_file_actions_init(&actions);
		actions_initialized = !error;
		if (!error)
			error = posix_spawn_file_actions_addchdir_np(&actions,
							       context->cwd);
		if (!error)
			error = posix_spawn(&pid, context->path, &actions, NULL,
					    argv, context->environment);
		if (actions_initialized)
			posix_spawn_file_actions_destroy(&actions);
		if (error) {
			errno = error;
			printf("posix-spawn-stress iteration=%d pages=%zu path=%p cwd=%p argv=%p envp=%p\n",
			       i, (size_t)__builtin_wasm_memory_size(0),
			       context->path, context->cwd, argv,
			       context->environment);
			test_perror("posix_spawn high-memory child");
		}
		if (waitpid(pid, &status, 0) == -1)
			test_perror("waitpid spawn child");
		if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
			test_fail("spawn child did not exit successfully");
	}

	/* Keep the forced growth observable to the optimizer through the soak. */
	if ((unsigned char)context->growth[growth_bytes - 1] != 0x5a)
		test_fail("growth buffer changed");
	return NULL;
}

int main(int argc, char **argv)
{
	pthread_t thread;
	struct spawn_context context = { 0 };
	void *result;

	if (argc == 2 && !strcmp(argv[1], "--child"))
		return 0;
	if (pthread_mutex_init(&context.mutex, NULL) ||
	    pthread_cond_init(&context.condition, NULL))
		test_fail("initialize spawn synchronization");
	if (pthread_create(&thread, NULL, spawn_stress, &context) != 0)
		test_fail("create spawn stress thread");

	/* Grow only after pthread_create has posted the child's InitMessage, then
	 * allocate every execve pointer beyond the child's captured old end. */
	context.growth = malloc(growth_bytes);
	if (!context.growth)
		test_perror("allocate growth buffer");
	memset(context.growth, 0x5a, growth_bytes);
	context.path = strdup("/init");
	context.cwd = strdup("/");
	if (!context.path || !context.cwd)
		test_perror("allocate spawn paths");
	for (int i = 0; i < environment_count; i++) {
		context.environment[i] = malloc(environment_value_bytes);
		if (!context.environment[i])
			test_perror("allocate spawn environment");
		int prefix = snprintf(context.environment[i], environment_value_bytes,
				      "STRESS_%d=", i);
		memset(context.environment[i] + prefix, 'a' + i % 26,
		       environment_value_bytes - prefix - 1);
		context.environment[i][environment_value_bytes - 1] = 0;
	}
	if (pthread_mutex_lock(&context.mutex))
		test_fail("lock spawn publication mutex");
	context.memory_ready = 1;
	if (pthread_cond_signal(&context.condition) ||
	    pthread_mutex_unlock(&context.mutex))
		test_fail("publish grown user memory");
	if (pthread_join(thread, &result) != 0 || result)
		test_fail("join spawn stress thread");
	test_pass();
}
