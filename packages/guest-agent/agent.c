#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <linux/vm_sockets.h>
#include <unistd.h>

enum {
	agent_port = 1024,
	protocol_magic = 0x584e4c54,
	protocol_version = 1,
	max_metadata = 64 * 1024,
	max_frame_payload = 64 * 1024 - 8,
	max_path = 4096,
	max_arguments = 256,
	max_environment = 256,
	worker_count = 12,
	live_job_capacity = worker_count - 1,
	job_capacity = 32,
	process_capacity = 2,
	process_live_slots = 4,
};

enum connection_kind {
	kind_ping = 1,
	kind_read_file,
	kind_write_file,
	kind_read_dir,
	kind_stat,
	kind_lstat,
	kind_mkdir,
	kind_remove,
	kind_rename,
	kind_copy_file,
	kind_real_path,
	kind_read_link,
	kind_symlink,
	kind_chmod,
	kind_chown,
	kind_truncate,
	kind_open_file,
	kind_exec_control = 32,
	kind_exec_stdin,
	kind_exec_stdout,
	kind_exec_stderr,
};

enum message_type {
	message_data = 1,
	message_end,
	message_error,
	message_entry,
	message_file_read = 16,
	message_file_write,
	message_file_seek,
	message_file_stat,
	message_file_truncate,
	message_file_sync,
	message_file_close,
	message_start = 32,
	message_signal,
	message_status,
};

enum write_flags {
	write_create = 1 << 0,
	write_create_new = 1 << 1,
	write_append = 1 << 2,
	write_truncate = 1 << 3,
};

struct frame {
	uint16_t type;
	uint16_t flags;
	uint32_t length;
	uint8_t *payload;
};

struct cursor {
	const uint8_t *data;
	size_t length;
	size_t offset;
};

struct job {
	int fd;
	uint16_t kind;
	uint32_t metadata_length;
	uint8_t *metadata;
};

struct job_queue {
	struct job jobs[job_capacity];
	size_t head;
	size_t length;
	size_t live_slots;
	pthread_mutex_t mutex;
	pthread_cond_t ready;
};

struct process_session {
	bool used;
	bool spawned;
	bool cancelled;
	bool exited;
	bool attached[3];
	int sockets[3];
	int pipes[3];
	int wait_status;
	uint64_t token;
	pid_t pid;
	unsigned streams_done;
	pthread_cond_t changed;
};

static struct job_queue jobs = {
	.mutex = PTHREAD_MUTEX_INITIALIZER,
	.ready = PTHREAD_COND_INITIALIZER,
};
static struct process_session processes[process_capacity];
static pthread_mutex_t processes_mutex = PTHREAD_MUTEX_INITIALIZER;
static uint64_t next_process_token = 1;

static uint16_t load_u16(const uint8_t *p)
{
	return (uint16_t)p[0] | (uint16_t)p[1] << 8;
}

static uint32_t load_u32(const uint8_t *p)
{
	return (uint32_t)p[0] | (uint32_t)p[1] << 8 |
	       (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static uint64_t load_u64(const uint8_t *p)
{
	return (uint64_t)load_u32(p) | (uint64_t)load_u32(p + 4) << 32;
}

static void store_u16(uint8_t *p, uint16_t value)
{
	p[0] = value;
	p[1] = value >> 8;
}

static void store_u32(uint8_t *p, uint32_t value)
{
	p[0] = value;
	p[1] = value >> 8;
	p[2] = value >> 16;
	p[3] = value >> 24;
}

static void store_u64(uint8_t *p, uint64_t value)
{
	store_u32(p, value);
	store_u32(p + 4, value >> 32);
}

static int read_all(int fd, void *buffer, size_t length)
{
	uint8_t *p = buffer;

	while (length) {
		ssize_t n = read(fd, p, length);
		if (n == 0) {
			errno = ECONNRESET;
			return -1;
		}
		if (n < 0) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		if (n == 0) {
			errno = EIO;
			return -1;
		}
		p += n;
		length -= n;
	}
	return 0;
}

static int write_all(int fd, const void *buffer, size_t length)
{
	const uint8_t *p = buffer;

	while (length) {
		ssize_t n = write(fd, p, length);
		if (n < 0) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		p += n;
		length -= n;
	}
	return 0;
}

static int send_frame(int fd, uint16_t type, const void *payload,
		      uint32_t length)
{
	uint8_t header[8];

	if (length > max_frame_payload) {
		errno = EOVERFLOW;
		return -1;
	}
	store_u32(header, length);
	store_u16(header + 4, type);
	store_u16(header + 6, 0);
	if (write_all(fd, header, sizeof(header)) == -1)
		return -1;
	return length ? write_all(fd, payload, length) : 0;
}

static int send_error(int fd, int error)
{
	uint8_t payload[4];

	store_u32(payload, error > 0 ? error : EIO);
	return send_frame(fd, message_error, payload, sizeof(payload));
}

static int reply_current_errno(int fd)
{
	int saved = errno;

	return send_error(fd, saved);
}

static int receive_frame(int fd, struct frame *frame)
{
	uint8_t header[8];

	memset(frame, 0, sizeof(*frame));
	if (read_all(fd, header, sizeof(header)) == -1)
		return -1;
	frame->length = load_u32(header);
	frame->type = load_u16(header + 4);
	frame->flags = load_u16(header + 6);
	if (frame->length > max_frame_payload || frame->flags != 0) {
		errno = EPROTO;
		return -1;
	}
	if (!frame->length)
		return 0;
	frame->payload = malloc(frame->length);
	if (!frame->payload)
		return -1;
	if (read_all(fd, frame->payload, frame->length) == -1) {
		free(frame->payload);
		frame->payload = NULL;
		return -1;
	}
	return 0;
}

static void free_frame(struct frame *frame)
{
	free(frame->payload);
	memset(frame, 0, sizeof(*frame));
}

static bool cursor_read(struct cursor *cursor, void *out, size_t length)
{
	if (cursor->offset > cursor->length ||
	    length > cursor->length - cursor->offset)
		return false;
	memcpy(out, cursor->data + cursor->offset, length);
	cursor->offset += length;
	return true;
}

static bool cursor_u32(struct cursor *cursor, uint32_t *out)
{
	uint8_t bytes[4];

	if (!cursor_read(cursor, bytes, sizeof(bytes)))
		return false;
	*out = load_u32(bytes);
	return true;
}

static bool cursor_u64(struct cursor *cursor, uint64_t *out)
{
	uint8_t bytes[8];

	if (!cursor_read(cursor, bytes, sizeof(bytes)))
		return false;
	*out = load_u64(bytes);
	return true;
}

static char *cursor_string(struct cursor *cursor)
{
	uint32_t length;
	char *string;

	if (!cursor_u32(cursor, &length) || length > max_path ||
	    cursor->offset > cursor->length ||
	    length > cursor->length - cursor->offset)
		return NULL;
	if (memchr(cursor->data + cursor->offset, 0, length))
		return NULL;
	string = malloc((size_t)length + 1);
	if (!string)
		return NULL;
	memcpy(string, cursor->data + cursor->offset, length);
	string[length] = 0;
	cursor->offset += length;
	return string;
}

static bool cursor_finished(const struct cursor *cursor)
{
	return cursor->offset == cursor->length;
}

static uint32_t file_kind(mode_t mode)
{
	if (S_ISREG(mode))
		return 1;
	if (S_ISDIR(mode))
		return 2;
	if (S_ISLNK(mode))
		return 3;
	return 0;
}

static int send_stat(int fd, const struct stat *st)
{
	uint8_t payload[88];

	store_u64(payload, st->st_size);
	store_u64(payload + 8, st->st_atim.tv_sec);
	store_u32(payload + 16, st->st_atim.tv_nsec);
	store_u64(payload + 20, st->st_mtim.tv_sec);
	store_u32(payload + 28, st->st_mtim.tv_nsec);
	store_u64(payload + 32, st->st_ctim.tv_sec);
	store_u32(payload + 40, st->st_ctim.tv_nsec);
	store_u64(payload + 44, st->st_ino);
	store_u64(payload + 52, st->st_dev);
	store_u64(payload + 60, st->st_blocks);
	store_u32(payload + 68, st->st_mode);
	store_u32(payload + 72, st->st_nlink);
	store_u32(payload + 76, st->st_uid);
	store_u32(payload + 80, st->st_gid);
	store_u32(payload + 84, file_kind(st->st_mode));
	return send_frame(fd, message_data, payload, sizeof(payload));
}

static int parse_path(const struct job *job, char **path)
{
	struct cursor cursor = { job->metadata, job->metadata_length, 0 };

	*path = cursor_string(&cursor);
	if (!*path || !cursor_finished(&cursor)) {
		free(*path);
		*path = NULL;
		errno = EINVAL;
		return -1;
	}
	return 0;
}

static int parse_two_paths(const struct job *job, char **first, char **second)
{
	struct cursor cursor = { job->metadata, job->metadata_length, 0 };

	*first = cursor_string(&cursor);
	*second = cursor_string(&cursor);
	if (!*first || !*second || !cursor_finished(&cursor)) {
		free(*first);
		free(*second);
		*first = NULL;
		*second = NULL;
		errno = EINVAL;
		return -1;
	}
	return 0;
}

static void handle_ping(const struct job *job)
{
	if (job->metadata_length) {
		send_error(job->fd, EINVAL);
		return;
	}
	if (send_frame(job->fd, message_data, "pong", 4) == 0)
		send_frame(job->fd, message_end, NULL, 0);
}

static void handle_read_file(const struct job *job)
{
	char *path = NULL;
	uint8_t buffer[max_frame_payload];
	int file;

	if (parse_path(job, &path) == -1) {
		reply_current_errno(job->fd);
		return;
	}
	file = open(path, O_RDONLY | O_CLOEXEC);
	free(path);
	if (file == -1) {
		reply_current_errno(job->fd);
		return;
	}
	for (;;) {
		ssize_t n = read(file, buffer, sizeof(buffer));
		if (n == 0) {
			send_frame(job->fd, message_end, NULL, 0);
			break;
		}
		if (n < 0) {
			if (errno == EINTR)
				continue;
			reply_current_errno(job->fd);
			break;
		}
		if (send_frame(job->fd, message_data, buffer, n) == -1)
			break;
	}
	close(file);
}

static void handle_write_file(const struct job *job)
{
	struct cursor cursor = { job->metadata, job->metadata_length, 0 };
	char *path = cursor_string(&cursor);
	uint32_t flags;
	uint32_t mode;
	int open_flags = O_WRONLY | O_CLOEXEC;
	int file;

	if (!path || !cursor_u32(&cursor, &flags) ||
	    !cursor_u32(&cursor, &mode) || !cursor_finished(&cursor)) {
		free(path);
		send_error(job->fd, EINVAL);
		return;
	}
	if (flags & write_create)
		open_flags |= O_CREAT;
	if (flags & write_create_new)
		open_flags |= O_CREAT | O_EXCL;
	if (flags & write_append)
		open_flags |= O_APPEND;
	if (flags & write_truncate)
		open_flags |= O_TRUNC;
	file = open(path, open_flags, mode);
	free(path);
	if (file == -1) {
		reply_current_errno(job->fd);
		return;
	}
	for (;;) {
		struct frame frame;
		if (receive_frame(job->fd, &frame) == -1)
			break;
		if (frame.type == message_end) {
			free_frame(&frame);
			send_frame(job->fd, message_end, NULL, 0);
			break;
		}
		if (frame.type != message_data ||
		    write_all(file, frame.payload, frame.length) == -1) {
			int saved = frame.type == message_data ? errno : EPROTO;
			free_frame(&frame);
			send_error(job->fd, saved);
			break;
		}
		free_frame(&frame);
	}
	close(file);
}

static void handle_read_dir(const struct job *job)
{
	char *path = NULL;
	DIR *directory;
	struct dirent *entry;

	if (parse_path(job, &path) == -1) {
		reply_current_errno(job->fd);
		return;
	}
	directory = opendir(path);
	free(path);
	if (!directory) {
		reply_current_errno(job->fd);
		return;
	}
	errno = 0;
	while ((entry = readdir(directory))) {
		uint8_t *payload;
		uint32_t kind = 0;
		size_t name_length;

		if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."))
			continue;
		if (entry->d_type == DT_REG)
			kind = 1;
		else if (entry->d_type == DT_DIR)
			kind = 2;
		else if (entry->d_type == DT_LNK)
			kind = 3;
		name_length = strlen(entry->d_name);
		payload = malloc(name_length + 4);
		if (!payload)
			break;
		store_u32(payload, kind);
		memcpy(payload + 4, entry->d_name, name_length);
		if (send_frame(job->fd, message_entry, payload,
			       name_length + 4) == -1) {
			free(payload);
			closedir(directory);
			return;
		}
		free(payload);
		errno = 0;
	}
	if (errno)
		reply_current_errno(job->fd);
	else
		send_frame(job->fd, message_end, NULL, 0);
	closedir(directory);
}

static void handle_stat_path(const struct job *job, bool follow)
{
	char *path = NULL;
	struct stat st;

	if (parse_path(job, &path) == -1) {
		reply_current_errno(job->fd);
		return;
	}
	if ((follow ? stat(path, &st) : lstat(path, &st)) == -1) {
		free(path);
		reply_current_errno(job->fd);
		return;
	}
	free(path);
	if (send_stat(job->fd, &st) == 0)
		send_frame(job->fd, message_end, NULL, 0);
}

static int mkdir_component(const char *path, mode_t mode)
{
	struct stat st;

	if (mkdir(path, mode) == 0)
		return 0;
	if (errno != EEXIST)
		return -1;
	if (stat(path, &st) == -1)
		return -1;
	if (S_ISDIR(st.st_mode))
		return 0;
	errno = ENOTDIR;
	return -1;
}

static int mkdir_recursive(const char *path, mode_t mode)
{
	char *copy = strdup(path);
	char *p;

	if (!copy)
		return -1;
	for (p = copy + 1; *p; p++) {
		if (*p != '/')
			continue;
		*p = 0;
		if (mkdir_component(copy, mode) == -1) {
			free(copy);
			return -1;
		}
		*p = '/';
	}
	if (mkdir_component(copy, mode) == -1) {
		free(copy);
		return -1;
	}
	free(copy);
	return 0;
}

static int remove_recursive(const char *path)
{
	struct stat st;
	DIR *directory;
	struct dirent *entry;

	if (lstat(path, &st) == -1)
		return -1;
	if (!S_ISDIR(st.st_mode))
		return unlink(path);
	directory = opendir(path);
	if (!directory)
		return -1;
	while ((entry = readdir(directory))) {
		char *child;
		int rc;

		if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."))
			continue;
		if (asprintf(&child, "%s/%s", path, entry->d_name) == -1) {
			closedir(directory);
			return -1;
		}
		rc = remove_recursive(child);
		free(child);
		if (rc == -1) {
			int saved = errno;
			closedir(directory);
			errno = saved;
			return -1;
		}
	}
	closedir(directory);
	return rmdir(path);
}

static void handle_mkdir(const struct job *job)
{
	struct cursor cursor = { job->metadata, job->metadata_length, 0 };
	char *path = cursor_string(&cursor);
	uint32_t recursive;
	uint32_t mode;
	int rc;

	if (!path || !cursor_u32(&cursor, &recursive) ||
	    !cursor_u32(&cursor, &mode) || !cursor_finished(&cursor)) {
		free(path);
		send_error(job->fd, EINVAL);
		return;
	}
	rc = recursive ? mkdir_recursive(path, mode) : mkdir(path, mode);
	free(path);
	if (rc == -1)
		reply_current_errno(job->fd);
	else
		send_frame(job->fd, message_end, NULL, 0);
}

static void handle_remove(const struct job *job)
{
	struct cursor cursor = { job->metadata, job->metadata_length, 0 };
	char *path = cursor_string(&cursor);
	uint32_t recursive;
	int rc;

	if (!path || !cursor_u32(&cursor, &recursive) ||
	    !cursor_finished(&cursor)) {
		free(path);
		send_error(job->fd, EINVAL);
		return;
	}
	if (recursive) {
		rc = remove_recursive(path);
	} else {
		rc = unlink(path);
		if (rc == -1 && (errno == EISDIR || errno == EPERM))
			rc = rmdir(path);
	}
	free(path);
	if (rc == -1)
		reply_current_errno(job->fd);
	else
		send_frame(job->fd, message_end, NULL, 0);
}

static void handle_rename(const struct job *job)
{
	char *from = NULL;
	char *to = NULL;
	int rc;

	if (parse_two_paths(job, &from, &to) == -1) {
		reply_current_errno(job->fd);
		return;
	}
	rc = rename(from, to);
	free(from);
	free(to);
	if (rc == -1)
		reply_current_errno(job->fd);
	else
		send_frame(job->fd, message_end, NULL, 0);
}

static void handle_copy_file(const struct job *job)
{
	char *from = NULL;
	char *to = NULL;
	uint8_t buffer[32 * 1024];
	struct stat input_stat;
	struct stat output_stat;
	int input = -1;
	int output = -1;
	int saved = 0;

	if (parse_two_paths(job, &from, &to) == -1) {
		reply_current_errno(job->fd);
		return;
	}
	input = open(from, O_RDONLY | O_CLOEXEC);
	if (input != -1 && fstat(input, &input_stat) == -1)
		saved = errno;
	if (input != -1 && !saved)
		output = open(to, O_WRONLY | O_CREAT | O_CLOEXEC, 0666);
	free(from);
	free(to);
	if (input == -1 || (!saved && output == -1)) {
		saved = errno;
		goto out;
	}
	if (saved)
		goto out;
	if (fstat(output, &output_stat) == -1) {
		saved = errno;
		goto out;
	}
	if (input_stat.st_dev == output_stat.st_dev &&
	    input_stat.st_ino == output_stat.st_ino) {
		saved = EINVAL;
		goto out;
	}
	if (ftruncate(output, 0) == -1) {
		saved = errno;
		goto out;
	}
	for (;;) {
		ssize_t n = read(input, buffer, sizeof(buffer));
		if (!n)
			break;
		if (n < 0) {
			if (errno == EINTR)
				continue;
			saved = errno;
			break;
		}
		if (write_all(output, buffer, n) == -1) {
			saved = errno;
			break;
		}
	}
out:
	if (input != -1)
		close(input);
	if (output != -1)
		close(output);
	if (saved)
		send_error(job->fd, saved);
	else
		send_frame(job->fd, message_end, NULL, 0);
}

static void handle_real_path(const struct job *job)
{
	char *path = NULL;
	char *resolved;

	if (parse_path(job, &path) == -1) {
		reply_current_errno(job->fd);
		return;
	}
	resolved = realpath(path, NULL);
	free(path);
	if (!resolved) {
		reply_current_errno(job->fd);
		return;
	}
	if (send_frame(job->fd, message_data, resolved, strlen(resolved)) == 0)
		send_frame(job->fd, message_end, NULL, 0);
	free(resolved);
}

static void handle_read_link(const struct job *job)
{
	char *path = NULL;
	char target[max_path];
	ssize_t length;

	if (parse_path(job, &path) == -1) {
		reply_current_errno(job->fd);
		return;
	}
	length = readlink(path, target, sizeof(target));
	free(path);
	if (length == -1) {
		reply_current_errno(job->fd);
		return;
	}
	if ((size_t)length == sizeof(target)) {
		send_error(job->fd, ENAMETOOLONG);
		return;
	}
	if (send_frame(job->fd, message_data, target, length) == 0)
		send_frame(job->fd, message_end, NULL, 0);
}

static void handle_symlink(const struct job *job)
{
	char *target = NULL;
	char *path = NULL;
	int rc;

	if (parse_two_paths(job, &target, &path) == -1) {
		reply_current_errno(job->fd);
		return;
	}
	rc = symlink(target, path);
	free(target);
	free(path);
	if (rc == -1)
		reply_current_errno(job->fd);
	else
		send_frame(job->fd, message_end, NULL, 0);
}

static void handle_chmod(const struct job *job)
{
	struct cursor cursor = { job->metadata, job->metadata_length, 0 };
	char *path = cursor_string(&cursor);
	uint32_t mode;
	int rc;

	if (!path || !cursor_u32(&cursor, &mode) || !cursor_finished(&cursor)) {
		free(path);
		send_error(job->fd, EINVAL);
		return;
	}
	rc = chmod(path, mode);
	free(path);
	if (rc == -1)
		reply_current_errno(job->fd);
	else
		send_frame(job->fd, message_end, NULL, 0);
}

static void handle_chown(const struct job *job)
{
	struct cursor cursor = { job->metadata, job->metadata_length, 0 };
	char *path = cursor_string(&cursor);
	uint32_t uid;
	uint32_t gid;
	int rc;

	if (!path || !cursor_u32(&cursor, &uid) ||
	    !cursor_u32(&cursor, &gid) || !cursor_finished(&cursor)) {
		free(path);
		send_error(job->fd, EINVAL);
		return;
	}
	rc = chown(path, uid, gid);
	free(path);
	if (rc == -1)
		reply_current_errno(job->fd);
	else
		send_frame(job->fd, message_end, NULL, 0);
}

static void handle_truncate(const struct job *job)
{
	struct cursor cursor = { job->metadata, job->metadata_length, 0 };
	char *path = cursor_string(&cursor);
	uint64_t length;
	int rc;

	if (!path || !cursor_u64(&cursor, &length) ||
	    !cursor_finished(&cursor)) {
		free(path);
		send_error(job->fd, EINVAL);
		return;
	}
	rc = truncate(path, length);
	free(path);
	if (rc == -1)
		reply_current_errno(job->fd);
	else
		send_frame(job->fd, message_end, NULL, 0);
}

static void handle_open_file(const struct job *job)
{
	struct cursor cursor = { job->metadata, job->metadata_length, 0 };
	char *path = cursor_string(&cursor);
	uint32_t flags;
	uint32_t mode;
	int file;

	if (!path || !cursor_u32(&cursor, &flags) ||
	    !cursor_u32(&cursor, &mode) || !cursor_finished(&cursor)) {
		free(path);
		send_error(job->fd, EINVAL);
		return;
	}
	file = open(path, flags | O_CLOEXEC, mode);
	free(path);
	if (file == -1) {
		reply_current_errno(job->fd);
		return;
	}
	if (send_frame(job->fd, message_end, NULL, 0) == -1)
		goto out;
	for (;;) {
		struct frame frame;
		uint8_t response[8];
		if (receive_frame(job->fd, &frame) == -1)
			break;
		switch (frame.type) {
		case message_file_read: {
			uint32_t length;
			uint8_t *buffer;
			ssize_t n;
			if (frame.length != 4 ||
			    (length = load_u32(frame.payload)) > max_frame_payload) {
				send_error(job->fd, EINVAL);
				break;
			}
			buffer = malloc(length ? length : 1);
			if (!buffer) {
				reply_current_errno(job->fd);
				break;
			}
			n = read(file, buffer, length);
			if (n < 0)
				reply_current_errno(job->fd);
			else if (n == 0)
				send_frame(job->fd, message_end, NULL, 0);
			else
				send_frame(job->fd, message_data, buffer, n);
			free(buffer);
			break;
		}
		case message_file_write: {
			ssize_t n = write(file, frame.payload, frame.length);
			if (n < 0)
				reply_current_errno(job->fd);
			else {
				store_u32(response, n);
				send_frame(job->fd, message_data, response, 4);
			}
			break;
		}
		case message_file_seek: {
			off_t offset;
			if (frame.length != 12) {
				send_error(job->fd, EINVAL);
				break;
			}
			offset = lseek(file, (int64_t)load_u64(frame.payload),
				       load_u32(frame.payload + 8));
			if (offset == (off_t)-1)
				reply_current_errno(job->fd);
			else {
				store_u64(response, offset);
				send_frame(job->fd, message_data, response, 8);
			}
			break;
		}
		case message_file_stat: {
			struct stat st;
			if (fstat(file, &st) == -1)
				reply_current_errno(job->fd);
			else
				send_stat(job->fd, &st);
			break;
		}
		case message_file_truncate:
			if (frame.length != 8)
				send_error(job->fd, EINVAL);
			else if (ftruncate(file, load_u64(frame.payload)) == -1)
				reply_current_errno(job->fd);
			else
				send_frame(job->fd, message_end, NULL, 0);
			break;
		case message_file_sync:
			if (frame.length)
				send_error(job->fd, EINVAL);
			else if (fsync(file) == -1)
				reply_current_errno(job->fd);
			else
				send_frame(job->fd, message_end, NULL, 0);
			break;
		case message_file_close:
			if (frame.length) {
				send_error(job->fd, EINVAL);
				break;
			}
			send_frame(job->fd, message_end, NULL, 0);
			free_frame(&frame);
			goto out;
		default:
			send_error(job->fd, EPROTO);
		}
		free_frame(&frame);
	}
out:
	close(file);
}

struct exec_spec {
	char **argv;
	uint32_t argc;
	char *cwd;
	char **env;
	uint32_t envc;
};

static void free_exec_spec(struct exec_spec *spec)
{
	uint32_t i;

	for (i = 0; i < spec->argc; i++)
		free(spec->argv[i]);
	for (i = 0; i < spec->envc; i++)
		free(spec->env[i]);
	free(spec->argv);
	free(spec->env);
	free(spec->cwd);
	memset(spec, 0, sizeof(*spec));
}

static int parse_exec_spec(const struct job *job, struct exec_spec *spec)
{
	struct cursor cursor = { job->metadata, job->metadata_length, 0 };
	uint32_t i;

	if (!cursor_u32(&cursor, &spec->argc) || !spec->argc ||
	    spec->argc > max_arguments)
		goto invalid;
	spec->argv = calloc((size_t)spec->argc + 1, sizeof(char *));
	if (!spec->argv)
		return -1;
	for (i = 0; i < spec->argc; i++) {
		spec->argv[i] = cursor_string(&cursor);
		if (!spec->argv[i])
			goto invalid;
	}
	spec->cwd = cursor_string(&cursor);
	if (!spec->cwd || !cursor_u32(&cursor, &spec->envc) ||
	    spec->envc > max_environment)
		goto invalid;
	spec->env = calloc((size_t)spec->envc + 1, sizeof(char *));
	if (!spec->env) {
		free_exec_spec(spec);
		return -1;
	}
	for (i = 0; i < spec->envc; i++) {
		spec->env[i] = cursor_string(&cursor);
		if (!spec->env[i] || !strchr(spec->env[i], '='))
			goto invalid;
	}
	if (!cursor_finished(&cursor))
		goto invalid;
	return 0;
invalid:
	errno = EINVAL;
	free_exec_spec(spec);
	return -1;
}

static struct process_session *find_process(uint64_t token)
{
	size_t i;

	for (i = 0; i < process_capacity; i++)
		if (processes[i].used && processes[i].token == token)
			return &processes[i];
	return NULL;
}

static struct process_session *find_process_by_pid(pid_t pid)
{
	size_t i;

	for (i = 0; i < process_capacity; i++)
		if (processes[i].used && processes[i].pid == pid)
			return &processes[i];
	return NULL;
}

static void *reap_children(void *unused)
{
	(void)unused;
	for (;;) {
		struct process_session *process;
		int status;
		pid_t pid = waitpid(-1, &status, WNOHANG);

		if (pid == -1 && errno == EINTR)
			continue;
		if (pid <= 0) {
			usleep(10 * 1000);
			continue;
		}
		pthread_mutex_lock(&processes_mutex);
		process = find_process_by_pid(pid);
		if (process) {
			process->exited = true;
			process->wait_status = status;
			pthread_cond_broadcast(&process->changed);
		}
		pthread_mutex_unlock(&processes_mutex);
	}
	return NULL;
}

static void cancel_process(struct process_session *process);

static void handle_exec_stream(const struct job *job, unsigned stream)
{
	struct cursor cursor = { job->metadata, job->metadata_length, 0 };
	struct process_session *process;
	uint64_t token;
	int pipe_fd = -1;
	int error = 0;

	if (!cursor_u64(&cursor, &token) || !cursor_finished(&cursor)) {
		send_error(job->fd, EINVAL);
		return;
	}
	pthread_mutex_lock(&processes_mutex);
	process = find_process(token);
	if (!process)
		error = ESRCH;
	else if (process->cancelled)
		error = ESHUTDOWN;
	else if (process->attached[stream])
		error = EALREADY;
	else {
		process->attached[stream] = true;
		process->sockets[stream] = job->fd;
		pthread_cond_broadcast(&process->changed);
	}
	pthread_mutex_unlock(&processes_mutex);
	if (error) {
		send_error(job->fd, error);
		return;
	}
	if (send_frame(job->fd, message_end, NULL, 0) == -1) {
		pthread_mutex_lock(&processes_mutex);
		cancel_process(process);
		pthread_mutex_unlock(&processes_mutex);
	}

	pthread_mutex_lock(&processes_mutex);
	while (!process->spawned && !process->cancelled)
		pthread_cond_wait(&process->changed, &processes_mutex);
	if (process->spawned)
		pipe_fd = process->pipes[stream];
	pthread_mutex_unlock(&processes_mutex);

	if (pipe_fd != -1 && stream == 0) {
		for (;;) {
			struct frame frame;

			if (receive_frame(job->fd, &frame) == -1)
				break;
			if (frame.type == message_end && frame.length == 0) {
				free_frame(&frame);
				break;
			}
			if (frame.type != message_data ||
			    write_all(pipe_fd, frame.payload, frame.length) == -1) {
				free_frame(&frame);
				send_error(job->fd, EPROTO);
				break;
			}
			free_frame(&frame);
		}
	} else if (pipe_fd != -1) {
		bool connected = true;
		uint8_t buffer[max_frame_payload];

		for (;;) {
			ssize_t n = read(pipe_fd, buffer, sizeof(buffer));

			if (n > 0) {
				if (connected &&
				    send_frame(job->fd, message_data, buffer, n) == -1)
					connected = false;
				continue;
			}
			if (n < 0 && errno == EINTR)
				continue;
			if (n == 0 && connected)
				send_frame(job->fd, message_end, NULL, 0);
			break;
		}
	}

	pthread_mutex_lock(&processes_mutex);
	if (process->pipes[stream] != -1) {
		close(process->pipes[stream]);
		process->pipes[stream] = -1;
	}
	process->sockets[stream] = -1;
	process->streams_done++;
	pthread_cond_broadcast(&process->changed);
	pthread_mutex_unlock(&processes_mutex);
}

static struct process_session *allocate_process(void)
{
	size_t i;

	for (i = 0; i < process_capacity; i++) {
		struct process_session *process = &processes[i];
		if (process->used)
			continue;
		process->used = true;
		process->token = next_process_token++;
		process->pid = -1;
		process->exited = false;
		process->wait_status = 0;
		process->streams_done = 0;
		for (size_t stream = 0; stream < 3; stream++) {
			process->sockets[stream] = -1;
			process->pipes[stream] = -1;
		}
		return process;
	}
	errno = EAGAIN;
	return NULL;
}

static void cancel_process(struct process_session *process)
{
	process->cancelled = true;
	if (process->pid > 0 && !process->exited)
		kill(process->pid, SIGKILL);
	for (size_t i = 0; i < 3; i++)
		if (process->sockets[i] != -1)
			shutdown(process->sockets[i], SHUT_RDWR);
	pthread_cond_broadcast(&process->changed);
}

static void release_process(struct process_session *process)
{
	process->used = false;
	process->spawned = false;
	process->cancelled = false;
	process->exited = false;
	memset(process->attached, 0, sizeof(process->attached));
	process->pid = -1;
	process->wait_status = 0;
	process->streams_done = 0;
	for (size_t i = 0; i < 3; i++) {
		process->sockets[i] = -1;
		process->pipes[i] = -1;
	}
}

static int spawn_process(struct process_session *process,
			 const struct exec_spec *spec)
{
	int input[2] = { -1, -1 };
	int output[2] = { -1, -1 };
	int error[2] = { -1, -1 };
	posix_spawn_file_actions_t actions;
	int rc;

	if (pipe2(input, O_CLOEXEC) == -1 || pipe2(output, O_CLOEXEC) == -1 ||
	    pipe2(error, O_CLOEXEC) == -1)
		goto failed;
	rc = posix_spawn_file_actions_init(&actions);
	if (rc) {
		errno = rc;
		goto failed;
	}
#define ADD_ACTION(action) do { if ((rc = (action))) goto actions_failed; } while (0)
	ADD_ACTION(posix_spawn_file_actions_adddup2(&actions, input[0], STDIN_FILENO));
	ADD_ACTION(posix_spawn_file_actions_adddup2(&actions, output[1], STDOUT_FILENO));
	ADD_ACTION(posix_spawn_file_actions_adddup2(&actions, error[1], STDERR_FILENO));
	ADD_ACTION(posix_spawn_file_actions_addclose(&actions, input[1]));
	ADD_ACTION(posix_spawn_file_actions_addclose(&actions, output[0]));
	ADD_ACTION(posix_spawn_file_actions_addclose(&actions, error[0]));
	ADD_ACTION(posix_spawn_file_actions_addchdir_np(&actions, spec->cwd));
#undef ADD_ACTION
	rc = posix_spawnp(&process->pid, spec->argv[0], &actions, NULL,
			  spec->argv, spec->env);
	posix_spawn_file_actions_destroy(&actions);
	if (rc) {
		errno = rc;
		goto failed;
	}
	close(input[0]);
	close(output[1]);
	close(error[1]);
	process->pipes[0] = input[1];
	process->pipes[1] = output[0];
	process->pipes[2] = error[0];
	process->spawned = true;
	pthread_cond_broadcast(&process->changed);
	return 0;

actions_failed:
	posix_spawn_file_actions_destroy(&actions);
	errno = rc;
failed:
	if (input[0] != -1)
		close(input[0]);
	if (input[1] != -1)
		close(input[1]);
	if (output[0] != -1)
		close(output[0]);
	if (output[1] != -1)
		close(output[1]);
	if (error[0] != -1)
		close(error[0]);
	if (error[1] != -1)
		close(error[1]);
	return -1;
}

static unsigned attached_streams(const struct process_session *process)
{
	return process->attached[0] + process->attached[1] +
	       process->attached[2];
}

static void handle_exec_control(const struct job *job)
{
	struct exec_spec spec = {};
	struct process_session *process;
	struct frame frame;
	uint8_t token[8];
	int status = 0;
	bool spec_owned = true;
	bool spawned = false;
	bool connected = true;
	bool reaped = false;
	int spawn_error = 0;

	if (parse_exec_spec(job, &spec) == -1) {
		reply_current_errno(job->fd);
		return;
	}
	pthread_mutex_lock(&processes_mutex);
	process = allocate_process();
	pthread_mutex_unlock(&processes_mutex);
	if (!process) {
		free_exec_spec(&spec);
		reply_current_errno(job->fd);
		return;
	}
	store_u64(token, process->token);
	if (send_frame(job->fd, message_data, token, sizeof(token)) == -1 ||
	    receive_frame(job->fd, &frame) == -1) {
		connected = false;
		goto cleanup;
	}
	if (frame.type != message_start || frame.length) {
		free_frame(&frame);
		send_error(job->fd, EPROTO);
		goto cleanup;
	}
	free_frame(&frame);

	pthread_mutex_lock(&processes_mutex);
	while (!process->cancelled && attached_streams(process) != 3)
		pthread_cond_wait(&process->changed, &processes_mutex);
	if (!process->cancelled && spawn_process(process, &spec) == 0)
		spawned = true;
	else if (!process->cancelled) {
		spawn_error = errno;
		cancel_process(process);
	}
	pthread_mutex_unlock(&processes_mutex);
	free_exec_spec(&spec);
	spec_owned = false;
	if (!spawned) {
		if (spawn_error)
			send_error(job->fd, spawn_error);
		goto cleanup;
	}
	store_u32(token, process->pid);
	if (send_frame(job->fd, message_data, token, 4) == -1) {
		connected = false;
		goto cleanup;
	}

	while (!reaped) {
		struct pollfd pollfd = { job->fd, POLLIN | POLLHUP, 0 };

		pthread_mutex_lock(&processes_mutex);
		if (process->exited) {
			status = process->wait_status;
			reaped = true;
		}
		pthread_mutex_unlock(&processes_mutex);
		if (reaped)
			break;
		if (poll(&pollfd, 1, 20) < 0) {
			if (errno == EINTR)
				continue;
			connected = false;
			break;
		}
		if (pollfd.revents & (POLLHUP | POLLERR | POLLNVAL)) {
			connected = false;
			break;
		}
		if (pollfd.revents & POLLIN) {
			struct frame command;

			if (receive_frame(job->fd, &command) == -1) {
				connected = false;
				break;
			}
			if (command.type == message_signal && command.length == 4) {
				pthread_mutex_lock(&processes_mutex);
				if (!process->exited)
					kill(process->pid, load_u32(command.payload));
				pthread_mutex_unlock(&processes_mutex);
			} else {
				send_error(job->fd, EPROTO);
				connected = false;
			}
			free_frame(&command);
		}
	}

	if (reaped) {
		uint8_t result[8];

		pthread_mutex_lock(&processes_mutex);
		process->pid = -1;
		if (process->sockets[0] != -1)
			shutdown(process->sockets[0], SHUT_RDWR);
		while (process->streams_done != 3)
			pthread_cond_wait(&process->changed, &processes_mutex);
		pthread_mutex_unlock(&processes_mutex);
		store_u32(result, WIFEXITED(status) ? WEXITSTATUS(status) : 0);
		store_u32(result + 4, WIFSIGNALED(status) ? WTERMSIG(status) : 0);
		if (send_frame(job->fd, message_status, result, sizeof(result)) == -1)
			connected = false;
	}

cleanup:
	if (spec_owned)
		free_exec_spec(&spec);
	if (!spawned || !connected) {
		pthread_mutex_lock(&processes_mutex);
		cancel_process(process);
		pthread_mutex_unlock(&processes_mutex);
	}
	pthread_mutex_lock(&processes_mutex);
	while (spawned && !process->exited)
		pthread_cond_wait(&process->changed, &processes_mutex);
	process->pid = -1;
	while (process->streams_done != attached_streams(process))
		pthread_cond_wait(&process->changed, &processes_mutex);
	release_process(process);
	pthread_mutex_unlock(&processes_mutex);
}

static void handle_job(struct job *job)
{
	switch (job->kind) {
	case kind_ping:
		handle_ping(job);
		break;
	case kind_read_file:
		handle_read_file(job);
		break;
	case kind_write_file:
		handle_write_file(job);
		break;
	case kind_read_dir:
		handle_read_dir(job);
		break;
	case kind_stat:
		handle_stat_path(job, true);
		break;
	case kind_lstat:
		handle_stat_path(job, false);
		break;
	case kind_mkdir:
		handle_mkdir(job);
		break;
	case kind_remove:
		handle_remove(job);
		break;
	case kind_rename:
		handle_rename(job);
		break;
	case kind_copy_file:
		handle_copy_file(job);
		break;
	case kind_real_path:
		handle_real_path(job);
		break;
	case kind_read_link:
		handle_read_link(job);
		break;
	case kind_symlink:
		handle_symlink(job);
		break;
	case kind_chmod:
		handle_chmod(job);
		break;
	case kind_chown:
		handle_chown(job);
		break;
	case kind_truncate:
		handle_truncate(job);
		break;
	case kind_open_file:
		handle_open_file(job);
		break;
	case kind_exec_control:
		handle_exec_control(job);
		break;
	case kind_exec_stdin:
	case kind_exec_stdout:
	case kind_exec_stderr:
		handle_exec_stream(job, job->kind - kind_exec_stdin);
		break;
	default:
		send_error(job->fd, ENOSYS);
		break;
	}
}

static size_t live_job_slots(uint16_t kind)
{
	if (kind == kind_open_file)
		return 1;
	if (kind == kind_exec_control)
		return process_live_slots;
	return 0;
}

static bool enqueue_job(struct job job)
{
	bool queued = false;
	size_t live_slots = live_job_slots(job.kind);

	pthread_mutex_lock(&jobs.mutex);
	if (jobs.length < job_capacity &&
	    live_slots <= live_job_capacity - jobs.live_slots) {
		size_t tail = (jobs.head + jobs.length) % job_capacity;

		jobs.jobs[tail] = job;
		jobs.length++;
		jobs.live_slots += live_slots;
		queued = true;
		pthread_cond_signal(&jobs.ready);
	}
	pthread_mutex_unlock(&jobs.mutex);
	return queued;
}

static struct job dequeue_job(void)
{
	struct job job;

	pthread_mutex_lock(&jobs.mutex);
	while (!jobs.length)
		pthread_cond_wait(&jobs.ready, &jobs.mutex);
	job = jobs.jobs[jobs.head];
	jobs.head = (jobs.head + 1) % job_capacity;
	jobs.length--;
	pthread_mutex_unlock(&jobs.mutex);
	return job;
}

static void *worker(void *unused)
{
	(void)unused;
	for (;;) {
		struct job job = dequeue_job();

		handle_job(&job);
		close(job.fd);
		free(job.metadata);
		if (live_job_slots(job.kind)) {
			pthread_mutex_lock(&jobs.mutex);
			jobs.live_slots -= live_job_slots(job.kind);
			pthread_mutex_unlock(&jobs.mutex);
		}
	}
	return NULL;
}

static int mount_if_needed(const char *source, const char *target,
			   const char *type)
{
	if (mount(source, target, type, 0, NULL) == -1 && errno != EBUSY)
		return -1;
	return 0;
}

int main(void)
{
	struct sockaddr_vm address = {
		.svm_family = AF_VSOCK,
		.svm_cid = VMADDR_CID_ANY,
		.svm_port = agent_port,
	};
	int server, rc;
	pthread_t reaper_thread;
	size_t i;

	signal(SIGPIPE, SIG_IGN);
	if (mount_if_needed("proc", "/proc", "proc") == -1 ||
	    mount_if_needed("sysfs", "/sys", "sysfs") == -1) {
		perror("mount");
		return 1;
	}
	for (i = 0; i < process_capacity; i++) {
		rc = pthread_cond_init(&processes[i].changed, NULL);
		if (rc) {
			errno = rc;
			perror("pthread_cond_init");
			return 1;
		}
	}
	rc = pthread_create(&reaper_thread, NULL, reap_children, NULL);
	if (rc) {
		errno = rc;
		perror("pthread_create reaper");
		return 1;
	}
	rc = pthread_detach(reaper_thread);
	if (rc) {
		errno = rc;
		perror("pthread_detach reaper");
		return 1;
	}
	for (i = 0; i < worker_count; i++) {
		pthread_t thread;

		rc = pthread_create(&thread, NULL, worker, NULL);
		if (rc) {
			errno = rc;
			perror("pthread_create");
			return 1;
		}
		rc = pthread_detach(thread);
		if (rc) {
			errno = rc;
			perror("pthread_detach");
			return 1;
		}
	}
	server = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (server == -1 ||
	    bind(server, (struct sockaddr *)&address, sizeof(address)) == -1 ||
	    listen(server, job_capacity) == -1) {
		perror("vsock listener");
		return 1;
	}
	printf("linux-guest-agent: ready on vsock port %d\n", agent_port);
	for (;;) {
		uint8_t prelude[12];
		struct job job = {};
		int fd;

		fd = accept4(server, NULL, NULL, SOCK_CLOEXEC);
		if (fd == -1) {
			if (errno != EINTR)
				perror("accept");
			continue;
		}
		if (read_all(fd, prelude, sizeof(prelude)) == -1 ||
		    load_u32(prelude) != protocol_magic ||
		    load_u16(prelude + 4) != protocol_version ||
		    load_u32(prelude + 8) > max_metadata) {
			close(fd);
			continue;
		}
		job.fd = fd;
		job.kind = load_u16(prelude + 6);
		job.metadata_length = load_u32(prelude + 8);
		if (job.metadata_length) {
			job.metadata = malloc(job.metadata_length);
			if (!job.metadata) {
				send_error(fd, ENOMEM);
				close(fd);
				continue;
			}
		}
		if (job.metadata_length &&
		    read_all(fd, job.metadata, job.metadata_length) == -1) {
			free(job.metadata);
			close(fd);
			continue;
		}
		if (!enqueue_job(job)) {
			send_error(fd, EAGAIN);
			free(job.metadata);
			close(fd);
		}
	}
}
