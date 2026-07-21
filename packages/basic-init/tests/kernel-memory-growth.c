#include "test.h"

#include <fcntl.h>
#include <pthread.h>
#include <stdlib.h>
#include <sys/mount.h>
#include <unistd.h>

#define CHUNK_SIZE (64 * 1024)
#define FILE_SIZE (8 * 1024 * 1024)

struct file {
	const char *path;
	unsigned char seed;
};

static pthread_barrier_t writers_ready;

static void fill_chunk(unsigned char *buffer, unsigned char seed, size_t chunk)
{
	memset(buffer, seed + chunk * 17, CHUNK_SIZE);
}

static void write_file(const struct file *file)
{
	unsigned char *buffer = malloc(CHUNK_SIZE);
	int fd;

	if (!buffer)
		test_fail("allocating write buffer");
	fd = open(file->path, O_CREAT | O_EXCL | O_WRONLY, 0600);
	if (fd == -1)
		test_perror("creating tmpfs file");
	for (size_t offset = 0; offset < FILE_SIZE; offset += CHUNK_SIZE) {
		fill_chunk(buffer, file->seed, offset / CHUNK_SIZE);
		if (write(fd, buffer, CHUNK_SIZE) != CHUNK_SIZE)
			test_perror("writing tmpfs file");
	}
	if (close(fd) == -1)
		test_perror("closing tmpfs file");
	free(buffer);
}

static void verify_file(const struct file *file)
{
	unsigned char *actual = malloc(CHUNK_SIZE);
	unsigned char *expected = malloc(CHUNK_SIZE);
	int fd;

	if (!actual || !expected)
		test_fail("allocating verification buffers");
	fd = open(file->path, O_RDONLY);
	if (fd == -1)
		test_perror("opening tmpfs file");
	for (size_t offset = 0; offset < FILE_SIZE; offset += CHUNK_SIZE) {
		fill_chunk(expected, file->seed, offset / CHUNK_SIZE);
		if (read(fd, actual, CHUNK_SIZE) != CHUNK_SIZE)
			test_perror("reading tmpfs file");
		if (memcmp(actual, expected, CHUNK_SIZE) != 0)
			test_fail("tmpfs contents changed across memory growth");
	}
	if (close(fd) == -1)
		test_perror("closing tmpfs file");
	free(expected);
	free(actual);
}

static void *write_file_thread(void *argument)
{
	int status = pthread_barrier_wait(&writers_ready);

	if (status != 0 && status != PTHREAD_BARRIER_SERIAL_THREAD)
		test_fail("waiting for concurrent writers");
	write_file(argument);
	return NULL;
}

static void wait_for_host(const char *marker)
{
	puts(marker);
	fflush(stdout);
	if (getchar() == EOF)
		test_fail("host closed console input");
}

int main(void)
{
	const struct file sequential = { "/tmp/sequential", 23 };
	const struct file concurrent[] = {
		{ "/tmp/concurrent-a", 71 },
		{ "/tmp/concurrent-b", 149 },
	};
	pthread_t threads[2];

	wait_for_host("::kernel-memory::ready");
	if (mount("tmpfs", "/tmp", "tmpfs", 0, "size=64m") == -1)
		test_perror("mounting tmpfs");

	write_file(&sequential);
	verify_file(&sequential);
	wait_for_host("::kernel-memory::sequential");

	if (pthread_barrier_init(&writers_ready, NULL, 3) != 0)
		test_fail("initializing concurrent writers");
	for (size_t i = 0; i < 2; i++)
		if (pthread_create(&threads[i], NULL, write_file_thread,
				   (void *)&concurrent[i]) != 0)
			test_fail("creating concurrent writer");
	{
		int status = pthread_barrier_wait(&writers_ready);

		if (status != 0 && status != PTHREAD_BARRIER_SERIAL_THREAD)
			test_fail("starting concurrent writers");
	}
	for (size_t i = 0; i < 2; i++)
		if (pthread_join(threads[i], NULL) != 0)
			test_fail("joining concurrent writer");
	if (pthread_barrier_destroy(&writers_ready) != 0)
		test_fail("destroying concurrent writer barrier");

	verify_file(&sequential);
	verify_file(&concurrent[0]);
	verify_file(&concurrent[1]);
	test_pass();
}
