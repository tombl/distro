#include "test.h"

#include <fcntl.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

enum {
	custom_section_size = 65 * 1024 * 1024,
};

static void copy_file(int to, int from)
{
	char buffer[16 * 1024];
	ssize_t length;

	while ((length = read(from, buffer, sizeof(buffer))) > 0) {
		char *position = buffer;

		while (length) {
			ssize_t written = write(to, position, length);
			if (written == -1)
				test_perror("write executable");
			position += written;
			length -= written;
		}
	}
	if (length == -1)
		test_perror("read /init");
}

int main(void)
{
	static const unsigned char custom_section_header[] = {
		0x00, 0x80, 0x80, 0xc0, 0x20,
	};
	char *const argv[] = { "/large-executable", "execed", NULL };
	struct stat executable;
	unsigned char zero = 0;
	int input, output;

	if (getenv("LARGE_EXECUTABLE"))
		test_pass();

	input = open("/init", O_RDONLY);
	if (input == -1)
		test_perror("open /init");
	output = open(argv[0], O_WRONLY | O_CREAT | O_TRUNC, 0755);
	if (output == -1)
		test_perror("create large executable");
	copy_file(output, input);
	if (write(output, custom_section_header, sizeof(custom_section_header)) !=
	    sizeof(custom_section_header))
		test_perror("write custom section header");
	if (lseek(output, custom_section_size - 1, SEEK_CUR) == (off_t)-1)
		test_perror("seek over custom section");
	if (write(output, &zero, sizeof(zero)) != sizeof(zero))
		test_perror("finish custom section");
	if (fstat(output, &executable) == -1)
		test_perror("stat large executable");
	if (executable.st_size <= 64 * 1024 * 1024)
		test_fail("dummy executable is not larger than 64 MiB");
	close(input);
	close(output);

	if (setenv("LARGE_EXECUTABLE", "1", 1) == -1)
		test_perror("setenv");
	execv(argv[0], argv);
	test_perror("exec large executable");
}
