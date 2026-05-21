#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <linux/vm_sockets.h>
#include <unistd.h>

#define AGENT_PORT 1024
#define AGENT_MAGIC 0x31414754u
#define AGENT_VERSION 1
#define MAX_PAYLOAD (1024u * 1024u)
#define MAX_PATH_LEN 4096u
#define MAX_ARGC 64u
#define MAX_ARG_LEN 4096u
#define MAX_EXEC_OUTPUT (1024u * 1024u)

extern char **environ;

enum agent_op {
	AGENT_OP_PING = 1,
	AGENT_OP_READ_FILE = 2,
	AGENT_OP_WRITE_FILE = 3,
	AGENT_OP_STAT = 4,
	AGENT_OP_LIST_DIR = 5,
	AGENT_OP_EXEC = 6,
};

enum write_flags {
	WRITE_CREATE = 1u << 0,
	WRITE_TRUNCATE = 1u << 1,
	WRITE_APPEND = 1u << 2,
};

struct agent_header {
	uint32_t magic;
	uint16_t version;
	uint16_t op;
	uint32_t id;
	int32_t status;
	uint32_t payload_len;
	uint32_t reserved;
};

struct bytes {
	uint8_t *data;
	size_t len;
	size_t cap;
};

struct exec_request {
	char **argv;
	uint32_t argc;
	uint32_t capture_limit;
};

static int mount_if_needed(const char *source, const char *target,
			   const char *fstype)
{
	if (mkdir(target, 0555) == -1 && errno != EEXIST) {
		perror(target);
		return -1;
	}

	if (mount(source, target, fstype, 0, NULL) == -1 && errno != EBUSY) {
		perror(target);
		return -1;
	}

	return 0;
}

static void reap_children(void)
{
	int status;

	while (waitpid(-1, &status, WNOHANG) > 0) {
	}
}

static int read_all(int fd, void *buf, size_t len)
{
	uint8_t *p = buf;

	while (len > 0) {
		ssize_t n = read(fd, p, len);
		if (n == 0)
			return -1;
		if (n == -1) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		p += n;
		len -= n;
	}

	return 0;
}

static int write_all(int fd, const void *buf, size_t len)
{
	const uint8_t *p = buf;

	while (len > 0) {
		ssize_t n = write(fd, p, len);
		if (n == -1) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		p += n;
		len -= n;
	}

	return 0;
}

static uint32_t load_u32(const uint8_t *p)
{
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
	       ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t load_u64(const uint8_t *p)
{
	uint64_t lo = load_u32(p);
	uint64_t hi = load_u32(p + 4);

	return lo | (hi << 32);
}

static void store_u32(uint8_t *p, uint32_t v)
{
	p[0] = v;
	p[1] = v >> 8;
	p[2] = v >> 16;
	p[3] = v >> 24;
}

static void store_u64(uint8_t *p, uint64_t v)
{
	store_u32(p, (uint32_t)v);
	store_u32(p + 4, (uint32_t)(v >> 32));
}

static int bytes_reserve(struct bytes *buf, size_t needed)
{
	uint8_t *next;
	size_t cap = buf->cap ? buf->cap : 256;

	while (cap < needed)
		cap *= 2;
	if (cap == buf->cap)
		return 0;

	next = realloc(buf->data, cap);
	if (!next)
		return -1;
	buf->data = next;
	buf->cap = cap;
	return 0;
}

static int bytes_append(struct bytes *buf, const void *data, size_t len)
{
	if (len > MAX_PAYLOAD || buf->len > MAX_PAYLOAD - len) {
		errno = EOVERFLOW;
		return -1;
	}
	if (bytes_reserve(buf, buf->len + len) == -1)
		return -1;
	memcpy(buf->data + buf->len, data, len);
	buf->len += len;
	return 0;
}

static int bytes_append_u8(struct bytes *buf, uint8_t v)
{
	return bytes_append(buf, &v, 1);
}

static int bytes_append_u32(struct bytes *buf, uint32_t v)
{
	uint8_t out[4];

	store_u32(out, v);
	return bytes_append(buf, out, sizeof(out));
}

static int bytes_append_u64(struct bytes *buf, uint64_t v)
{
	uint8_t out[8];

	store_u64(out, v);
	return bytes_append(buf, out, sizeof(out));
}

static char *parse_path(const uint8_t *payload, size_t len, size_t *offset)
{
	uint32_t path_len;
	char *path;

	if (*offset > len || len - *offset < 4)
		return NULL;
	path_len = load_u32(payload + *offset);
	*offset += 4;
	if (path_len == 0 || path_len > MAX_PATH_LEN ||
	    *offset > len || len - *offset < path_len)
		return NULL;

	path = malloc((size_t)path_len + 1);
	if (!path)
		return NULL;
	memcpy(path, payload + *offset, path_len);
	path[path_len] = 0;
	*offset += path_len;
	return path;
}

static int send_response(int fd, const struct agent_header *req, int status,
			 const void *payload, uint32_t payload_len)
{
	struct agent_header hdr = {
		.magic = AGENT_MAGIC,
		.version = AGENT_VERSION,
		.op = req->op,
		.id = req->id,
		.status = status,
		.payload_len = payload_len,
		.reserved = 0,
	};

	if (write_all(fd, &hdr, sizeof(hdr)) == -1)
		return -1;
	if (payload_len > 0 && write_all(fd, payload, payload_len) == -1)
		return -1;
	return 0;
}

static int reply_errno(int fd, const struct agent_header *req)
{
	return send_response(fd, req, -errno, NULL, 0);
}

static int handle_ping(int fd, const struct agent_header *req)
{
	return send_response(fd, req, 0, "pong", 4);
}

static int handle_read_file(int fd, const struct agent_header *req,
			    const uint8_t *payload)
{
	size_t off = 0;
	char *path;
	uint64_t file_off;
	uint32_t length;
	int file;
	uint8_t *data;
	ssize_t n;
	int saved_errno;

	if (req->payload_len < 16) {
		errno = EINVAL;
		return reply_errno(fd, req);
	}
	path = parse_path(payload, req->payload_len, &off);
	if (!path || req->payload_len - off < 12) {
		free(path);
		errno = EINVAL;
		return reply_errno(fd, req);
	}

	file_off = load_u64(payload + off);
	length = load_u32(payload + off + 8);
	if (length > MAX_PAYLOAD) {
		free(path);
		errno = EOVERFLOW;
		return reply_errno(fd, req);
	}

	data = malloc(length ? length : 1);
	if (!data) {
		free(path);
		errno = ENOMEM;
		return reply_errno(fd, req);
	}

	file = open(path, O_RDONLY);
	free(path);
	if (file == -1) {
		free(data);
		return reply_errno(fd, req);
	}

	n = pread(file, data, length, (off_t)file_off);
	saved_errno = errno;
	close(file);
	if (n == -1) {
		free(data);
		errno = saved_errno;
		return reply_errno(fd, req);
	}

	send_response(fd, req, 0, data, (uint32_t)n);
	free(data);
	return 0;
}

static int handle_write_file(int fd, const struct agent_header *req,
			     const uint8_t *payload)
{
	size_t off = 0;
	char *path;
	uint32_t mode;
	uint32_t flags;
	uint64_t file_off;
	uint32_t data_len;
	int open_flags = O_WRONLY;
	int file;
	ssize_t n;
	uint8_t out[8];
	int saved_errno;

	if (req->payload_len < 24) {
		errno = EINVAL;
		return reply_errno(fd, req);
	}
	path = parse_path(payload, req->payload_len, &off);
	if (!path || req->payload_len - off < 20) {
		free(path);
		errno = EINVAL;
		return reply_errno(fd, req);
	}

	mode = load_u32(payload + off);
	file_off = load_u64(payload + off + 4);
	data_len = load_u32(payload + off + 12);
	flags = load_u32(payload + off + 16);
	off += 20;

	if (req->payload_len - off < data_len) {
		free(path);
		errno = EINVAL;
		return reply_errno(fd, req);
	}

	if (flags & WRITE_CREATE)
		open_flags |= O_CREAT;
	if (flags & WRITE_TRUNCATE)
		open_flags |= O_TRUNC;
	if (flags & WRITE_APPEND)
		open_flags |= O_APPEND;

	file = open(path, open_flags, mode ? mode : 0644);
	free(path);
	if (file == -1)
		return reply_errno(fd, req);

	n = (flags & WRITE_APPEND) ? write(file, payload + off, data_len) :
				     pwrite(file, payload + off, data_len,
					    (off_t)file_off);
	saved_errno = errno;
	close(file);
	if (n == -1) {
		errno = saved_errno;
		return reply_errno(fd, req);
	}

	store_u64(out, (uint64_t)n);
	return send_response(fd, req, 0, out, sizeof(out));
}

static uint32_t file_kind(mode_t mode)
{
	if (S_ISDIR(mode))
		return 2;
	if (S_ISLNK(mode))
		return 3;
	if (S_ISREG(mode))
		return 1;
	return 0;
}

static int handle_stat(int fd, const struct agent_header *req,
		       const uint8_t *payload)
{
	size_t off = 0;
	char *path = parse_path(payload, req->payload_len, &off);
	struct stat st;
	uint8_t out[40];

	if (!path || off != req->payload_len) {
		free(path);
		errno = EINVAL;
		return reply_errno(fd, req);
	}

	if (lstat(path, &st) == -1) {
		free(path);
		return reply_errno(fd, req);
	}
	free(path);

	store_u64(out, (uint64_t)st.st_size);
	store_u32(out + 8, (uint32_t)st.st_mode);
	store_u32(out + 12, (uint32_t)st.st_uid);
	store_u32(out + 16, (uint32_t)st.st_gid);
	store_u32(out + 20, file_kind(st.st_mode));
	store_u64(out + 24, (uint64_t)st.st_mtime);
	store_u64(out + 32, (uint64_t)st.st_ino);
	return send_response(fd, req, 0, out, sizeof(out));
}

static int handle_list_dir(int fd, const struct agent_header *req,
			   const uint8_t *payload)
{
	size_t off = 0;
	char *path = parse_path(payload, req->payload_len, &off);
	DIR *dir;
	struct dirent *entry;
	struct bytes out = {};
	int saved_errno = 0;

	if (!path || off != req->payload_len) {
		free(path);
		errno = EINVAL;
		return reply_errno(fd, req);
	}

	dir = opendir(path);
	free(path);
	if (!dir)
		return reply_errno(fd, req);

	while ((entry = readdir(dir))) {
		uint32_t name_len;
		uint8_t kind = 0;

		if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."))
			continue;

		name_len = strlen(entry->d_name);
		if (entry->d_type == DT_REG)
			kind = 1;
		else if (entry->d_type == DT_DIR)
			kind = 2;
		else if (entry->d_type == DT_LNK)
			kind = 3;

		if (bytes_append_u8(&out, kind) == -1 ||
		    bytes_append_u32(&out, name_len) == -1 ||
		    bytes_append(&out, entry->d_name, name_len) == -1) {
			saved_errno = errno;
			break;
		}
	}

	closedir(dir);
	if (saved_errno) {
		free(out.data);
		errno = saved_errno;
		return reply_errno(fd, req);
	}

	send_response(fd, req, 0, out.data, (uint32_t)out.len);
	free(out.data);
	return 0;
}

static void free_exec_request(struct exec_request *exec)
{
	uint32_t i;

	if (!exec->argv)
		return;
	for (i = 0; i < exec->argc; i++)
		free(exec->argv[i]);
	free(exec->argv);
}

static int parse_exec_request(const uint8_t *payload, size_t len,
			      struct exec_request *exec)
{
	size_t off = 0;
	uint32_t i;

	if (len < 8) {
		errno = EINVAL;
		return -1;
	}

	exec->argc = load_u32(payload);
	exec->capture_limit = load_u32(payload + 4);
	off = 8;
	if (exec->argc == 0 || exec->argc > MAX_ARGC ||
	    exec->capture_limit > MAX_EXEC_OUTPUT) {
		errno = EINVAL;
		return -1;
	}

	exec->argv = calloc((size_t)exec->argc + 1, sizeof(char *));
	if (!exec->argv) {
		errno = ENOMEM;
		return -1;
	}

	for (i = 0; i < exec->argc; i++) {
		uint32_t arg_len;

		if (off > len || len - off < 4) {
			errno = EINVAL;
			return -1;
		}
		arg_len = load_u32(payload + off);
		off += 4;
		if (arg_len > MAX_ARG_LEN || off > len || len - off < arg_len) {
			errno = EINVAL;
			return -1;
		}
		exec->argv[i] = malloc((size_t)arg_len + 1);
		if (!exec->argv[i]) {
			errno = ENOMEM;
			return -1;
		}
		memcpy(exec->argv[i], payload + off, arg_len);
		exec->argv[i][arg_len] = 0;
		off += arg_len;
	}

	if (off != len) {
		errno = EINVAL;
		return -1;
	}
	return 0;
}

struct child_exec {
	char **argv;
	int stdout_fd;
	int stderr_fd;
};

static int child_exec(void *arg)
{
	struct child_exec *child = arg;

	fprintf(stderr, "basic-init: exec child started\n");
	if (dup2(child->stdout_fd, STDOUT_FILENO) == -1)
		perror("dup2 stdout");
	if (dup2(child->stderr_fd, STDERR_FILENO) == -1)
		perror("dup2 stderr");
	close(child->stdout_fd);
	close(child->stderr_fd);
	execve(child->argv[0], child->argv, environ);
	perror("execve");
	_exit(127);
}

static void set_nonblock(int fd)
{
	int flags = fcntl(fd, F_GETFL, 0);

	if (flags != -1)
		fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int drain_fd(int fd, struct bytes *out, size_t limit)
{
	uint8_t tmp[4096];

	for (;;) {
		ssize_t n = read(fd, tmp, sizeof(tmp));
		if (n > 0) {
			size_t avail = limit > out->len ? limit - out->len : 0;
			size_t take = (size_t)n < avail ? (size_t)n : avail;
			if (take && bytes_append(out, tmp, take) == -1)
				return -1;
			continue;
		}
		if (n == 0)
			return 1;
		if (errno == EINTR)
			continue;
		if (errno == EAGAIN || errno == EWOULDBLOCK)
			return 0;
		return -1;
	}
}

static int handle_exec(int fd, const struct agent_header *req,
		       const uint8_t *payload)
{
	struct exec_request exec = {};
	struct agent_header response_req = *req;
	int out_pipe[2] = { -1, -1 };
	int err_pipe[2] = { -1, -1 };
	struct child_exec child;
	pid_t pid;
	int status = 0;
	struct bytes stdout_buf = {};
	struct bytes stderr_buf = {};
	struct bytes response = {};
	uint8_t header[20];
	/*
	 * TODO(wasm32): heap/static child stacks currently stall during exec.
	 * Keep this on the active stack until clone stack switching is fixed
	 * enough for arbitrary user-provided stacks.
	 */
	uint8_t child_stack[16 * 1024];
	size_t capture_limit;
	int exited = 0;
	int out_open = 1;
	int err_open = 1;
	int rc = 0;

	if (parse_exec_request(payload, req->payload_len, &exec) == -1) {
		free_exec_request(&exec);
		return reply_errno(fd, req);
	}

	if (pipe(out_pipe) == -1 || pipe(err_pipe) == -1) {
		rc = reply_errno(fd, req);
		goto out;
	}

	child.argv = exec.argv;
	child.stdout_fd = out_pipe[1];
	child.stderr_fd = err_pipe[1];
	/* TODO(wasm32): remove these exec diagnostics after clone stack handling is deterministic. */
	fprintf(stderr, "basic-init: clone exec %s\n", exec.argv[0]);
	pid = clone(child_exec, child_stack + sizeof(child_stack), SIGCHLD,
		    &child);
	if (pid == -1) {
		rc = reply_errno(fd, req);
		goto out;
	}
	fprintf(stderr, "basic-init: cloned exec pid %d\n", pid);

	close(out_pipe[1]);
	close(err_pipe[1]);
	out_pipe[1] = -1;
	err_pipe[1] = -1;
	set_nonblock(out_pipe[0]);
	set_nonblock(err_pipe[0]);
	capture_limit = exec.capture_limit ? exec.capture_limit : 64 * 1024;

	while (!exited || out_open || err_open) {
		struct pollfd fds[2];
		int nfds = 0;

		if (out_open) {
			fds[nfds].fd = out_pipe[0];
			fds[nfds].events = POLLIN | POLLHUP;
			nfds++;
		}
		if (err_open) {
			fds[nfds].fd = err_pipe[0];
			fds[nfds].events = POLLIN | POLLHUP;
			nfds++;
		}

		if (nfds > 0)
			poll(fds, nfds, 50);

		if (out_open) {
			size_t before = stdout_buf.len;
			int drained = drain_fd(out_pipe[0], &stdout_buf,
					       capture_limit);
			if (drained == -1) {
				rc = reply_errno(fd, req);
				goto out;
			}
			if (stdout_buf.len != before)
				fprintf(stderr, "basic-init: exec stdout bytes %zu\n",
					stdout_buf.len);
			if (drained == 1)
				out_open = 0;
		}
		if (err_open) {
			size_t before = stderr_buf.len;
			int drained = drain_fd(err_pipe[0], &stderr_buf,
					       capture_limit);
			if (drained == -1) {
				rc = reply_errno(fd, req);
				goto out;
			}
			if (stderr_buf.len != before)
				fprintf(stderr, "basic-init: exec stderr bytes %zu\n",
					stderr_buf.len);
			if (drained == 1)
				err_open = 0;
		}

		if (!exited) {
			pid_t got = waitpid(pid, &status, WNOHANG);
			if (got == pid) {
				fprintf(stderr, "basic-init: exec pid %d exited status %d\n",
					pid, status);
				exited = 1;
			} else if (got == -1 && errno != EINTR) {
				rc = reply_errno(fd, req);
				goto out;
			}
		}
	}

	store_u32(header, (uint32_t)status);
	store_u32(header + 4, WIFEXITED(status) ? (uint32_t)WEXITSTATUS(status) : 0);
	store_u32(header + 8, WIFSIGNALED(status) ? (uint32_t)WTERMSIG(status) : 0);
	store_u32(header + 12, (uint32_t)stdout_buf.len);
	store_u32(header + 16, (uint32_t)stderr_buf.len);
	if (bytes_append(&response, header, sizeof(header)) == -1 ||
	    bytes_append(&response, stdout_buf.data, stdout_buf.len) == -1 ||
	    bytes_append(&response, stderr_buf.data, stderr_buf.len) == -1) {
		rc = reply_errno(fd, req);
		goto out;
	}

	rc = send_response(fd, &response_req, 0, response.data,
			   (uint32_t)response.len);

out:
	if (out_pipe[0] != -1)
		close(out_pipe[0]);
	if (out_pipe[1] != -1)
		close(out_pipe[1]);
	if (err_pipe[0] != -1)
		close(err_pipe[0]);
	if (err_pipe[1] != -1)
		close(err_pipe[1]);
	free(stdout_buf.data);
	free(stderr_buf.data);
	free(response.data);
	free_exec_request(&exec);
	return rc;
}

static void handle_client(int fd)
{
	for (;;) {
		struct agent_header req;
		uint8_t *payload = NULL;
		int rc;

		if (read_all(fd, &req, sizeof(req)) == -1)
			return;
		if (req.magic != AGENT_MAGIC || req.version != AGENT_VERSION ||
		    req.payload_len > MAX_PAYLOAD) {
			return;
		}

		if (req.payload_len) {
			payload = malloc(req.payload_len);
			if (!payload)
				return;
			if (read_all(fd, payload, req.payload_len) == -1) {
				free(payload);
				return;
			}
		}

		switch (req.op) {
		case AGENT_OP_PING:
			rc = handle_ping(fd, &req);
			break;
		case AGENT_OP_READ_FILE:
			rc = handle_read_file(fd, &req, payload);
			break;
		case AGENT_OP_WRITE_FILE:
			rc = handle_write_file(fd, &req, payload);
			break;
		case AGENT_OP_STAT:
			rc = handle_stat(fd, &req, payload);
			break;
		case AGENT_OP_LIST_DIR:
			rc = handle_list_dir(fd, &req, payload);
			break;
		case AGENT_OP_EXEC:
			rc = handle_exec(fd, &req, payload);
			break;
		default:
			errno = ENOSYS;
			rc = reply_errno(fd, &req);
			break;
		}

		free(payload);
		if (rc == -1)
			return;
		reap_children();
	}
}

int main(void)
{
	int server;
	struct sockaddr_vm addr = {
		.svm_family = AF_VSOCK,
		.svm_cid = VMADDR_CID_ANY,
		.svm_port = AGENT_PORT,
	};

	printf("basic-init: starting guest agent on vsock port %d\n", AGENT_PORT);

	if (mount_if_needed("proc", "/proc", "proc") == -1)
		return 1;
	if (mount_if_needed("sysfs", "/sys", "sysfs") == -1)
		return 1;
	mkdir("/tmp", 01777);

	server = socket(AF_VSOCK, SOCK_STREAM, 0);
	if (server == -1) {
		perror("socket AF_VSOCK");
		return 1;
	}

	if (bind(server, (struct sockaddr *)&addr, sizeof(addr)) == -1) {
		perror("bind AF_VSOCK");
		return 1;
	}

	if (listen(server, 8) == -1) {
		perror("listen AF_VSOCK");
		return 1;
	}

	for (;;) {
		int client;

		reap_children();
		client = accept(server, NULL, NULL);
		if (client == -1) {
			if (errno == EINTR)
				continue;
			perror("accept AF_VSOCK");
			sched_yield();
			continue;
		}

		handle_client(client);
		close(client);
	}
}
