#define _GNU_SOURCE

#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

struct linux_dirent64 {
	uint64_t ino;
	int64_t off;
	unsigned short reclen;
	unsigned char type;
	char name[];
};

int main(int argc, char **argv)
{
	char buffer[4096];
	int fd;
	int reference_fd;
	long length;
	long offset;
	struct stat reference;

	if (argc != 4)
		return 2;
	reference_fd = open(argv[3], O_RDONLY | O_DIRECTORY);
	if (reference_fd < 0) {
		perror("open reference");
		return 1;
	}
	if (fstat(reference_fd, &reference) < 0) {
		perror("fstat reference");
		return 1;
	}
	fd = open(argv[1], O_RDONLY | O_DIRECTORY);
	if (fd < 0) {
		perror("open");
		return 1;
	}
	length = syscall(SYS_getdents64, fd, buffer, sizeof(buffer));
	if (length < 0) {
		perror("getdents64");
		return 1;
	}
	for (offset = 0; offset < length;) {
		struct linux_dirent64 *entry = (void *)(buffer + offset);
		if (strcmp(entry->name, argv[2]) == 0) {
			printf("%llu %llu\n", (unsigned long long)entry->ino,
			       (unsigned long long)reference.st_ino);
			return 0;
		}
		offset += entry->reclen;
	}
	return 1;
}
