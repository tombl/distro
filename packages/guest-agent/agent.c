#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
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
#include <sys/types.h>
#include <sys/wait.h>
#include <linux/vm_sockets.h>
#include <unistd.h>

enum {
	agent_port = 1024,
	protocol_magic = 0x584e4c54,
	protocol_version = 2,
	max_payload = 128 * 1024,
	max_string = 4096,
	max_arguments = 256,
	max_environment = 256,
	syscall_args = 6,
	worker_count = 12,
	ring_capacity = 32,
	process_capacity = 16,
};

enum frame_type {
	frame_syscall = 1,
	frame_spawn = 2,
	frame_reply = 3,
	frame_reap = 4,
};

enum arg_kind {
	arg_scalar = 0,
	arg_in_blob = 1,
	arg_out_full = 2,
	arg_out_ret = 3,
};

struct request {
	uint32_t id;
	uint16_t type;
	uint32_t length;
	uint8_t *payload;
};

static struct {
	struct request items[ring_capacity];
	size_t head;
	size_t count;
	size_t outstanding;
	pthread_mutex_t mutex;
	pthread_cond_t not_empty;
	pthread_cond_t not_full;
	pthread_cond_t drained;
} ring = {
	.mutex = PTHREAD_MUTEX_INITIALIZER,
	.not_empty = PTHREAD_COND_INITIALIZER,
	.not_full = PTHREAD_COND_INITIALIZER,
	.drained = PTHREAD_COND_INITIALIZER,
};

static struct {
	int fd;
	volatile sig_atomic_t dead;
	pthread_mutex_t write_mutex;
} conn = {
	.fd = -1,
	.write_mutex = PTHREAD_MUTEX_INITIALIZER,
};

static struct {
	pid_t pid;
	bool used;
} children[process_capacity];
static pthread_mutex_t children_mutex = PTHREAD_MUTEX_INITIALIZER;

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

struct cursor {
	const uint8_t *data;
	size_t length;
	size_t offset;
};

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

static char *cursor_string(struct cursor *cursor)
{
	uint32_t length;
	char *string;

	if (!cursor_u32(cursor, &length) || length > max_string ||
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

/* The reader owns accept/read; workers only ever pop and reply. */
static void ring_push(struct request req)
{
	pthread_mutex_lock(&ring.mutex);
	while (ring.count == ring_capacity)
		pthread_cond_wait(&ring.not_full, &ring.mutex);
	ring.items[(ring.head + ring.count) % ring_capacity] = req;
	ring.count++;
	ring.outstanding++;
	pthread_cond_signal(&ring.not_empty);
	pthread_mutex_unlock(&ring.mutex);
}

static struct request ring_pop(void)
{
	struct request req;

	pthread_mutex_lock(&ring.mutex);
	while (ring.count == 0)
		pthread_cond_wait(&ring.not_empty, &ring.mutex);
	req = ring.items[ring.head];
	ring.head = (ring.head + 1) % ring_capacity;
	ring.count--;
	pthread_cond_signal(&ring.not_full);
	pthread_mutex_unlock(&ring.mutex);
	return req;
}

static void ring_done(void)
{
	pthread_mutex_lock(&ring.mutex);
	if (--ring.outstanding == 0)
		pthread_cond_signal(&ring.drained);
	pthread_mutex_unlock(&ring.mutex);
}

static void ring_drain(void)
{
	pthread_mutex_lock(&ring.mutex);
	while (ring.outstanding)
		pthread_cond_wait(&ring.drained, &ring.mutex);
	pthread_mutex_unlock(&ring.mutex);
}

/* Tear down a connection detected as malformed mid-flight: wake the reader
 * out of its blocking read so it can run disconnect cleanup. */
static void mark_dead(void)
{
	conn.dead = 1;
	shutdown(conn.fd, SHUT_RDWR);
}

static void send_reply(uint32_t id, int64_t ret, uint32_t err,
		       const void *body, uint32_t body_len)
{
	uint8_t head[28];

	store_u32(head, 16 + body_len);
	store_u32(head + 4, id);
	store_u16(head + 8, frame_reply);
	store_u16(head + 10, 0);
	store_u64(head + 12, (uint64_t)ret);
	store_u32(head + 20, err);
	store_u32(head + 24, 0);
	/* Writes on a dead connection fail silently; SIGPIPE is ignored. */
	pthread_mutex_lock(&conn.write_mutex);
	if (write_all(conn.fd, head, sizeof(head)) == 0 && body_len)
		write_all(conn.fd, body, body_len);
	pthread_mutex_unlock(&conn.write_mutex);
}

static void handle_syscall(const struct request *req)
{
	const uint8_t *p = req->payload;
	size_t header = 8 + syscall_args * 12;
	size_t consumed = 0;
	size_t tail;
	unsigned long args[syscall_args] = { 0 };
	uint8_t *blobs[syscall_args] = { 0 };
	uint8_t *outs[syscall_args] = { 0 };
	uint32_t out_cap[syscall_args] = { 0 };
	uint8_t out_mode[syscall_args] = { 0 };
	uint32_t take[syscall_args] = { 0 };
	uint32_t body_len = 0;
	uint8_t *body = NULL;
	uint64_t out_total = 0;
	long nr, ret;
	int err, i;

	if (req->length < header)
		goto malformed;
	tail = req->length - header;
	nr = (long)load_u32(p);
	for (i = 0; i < syscall_args; i++) {
		uint32_t kind = load_u32(p + 8 + i * 12);
		uint64_t value = load_u64(p + 8 + i * 12 + 4);

		switch (kind) {
		case arg_scalar:
			args[i] = (unsigned long)value;
			break;
		case arg_in_blob:
			if (value > (uint64_t)(tail - consumed))
				goto malformed;
			blobs[i] = malloc(value ? value : 1);
			if (!blobs[i])
				goto malformed;
			memcpy(blobs[i], p + header + consumed, value);
			consumed += value;
			args[i] = (unsigned long)(uintptr_t)blobs[i];
			break;
		case arg_out_full:
		case arg_out_ret:
			/* The reply must also fit max_payload: 16-byte reply
			 * preamble plus every out-blob at full capacity. */
			out_total += value;
			if (out_total > max_payload - 16)
				goto malformed;
			outs[i] = calloc(value ? value : 1, 1);
			if (!outs[i])
				goto malformed;
			out_cap[i] = (uint32_t)value;
			out_mode[i] = kind;
			args[i] = (unsigned long)(uintptr_t)outs[i];
			break;
		default:
			goto malformed;
		}
	}
	if (consumed != tail)
		goto malformed;

	ret = (long)syscall(nr, args[0], args[1], args[2], args[3], args[4],
			    args[5]);
	err = ret == -1 ? errno : 0;

	if (ret != -1) {
		for (i = 0; i < syscall_args; i++) {
			if (out_mode[i] == arg_out_full)
				take[i] = out_cap[i];
			else if (out_mode[i] == arg_out_ret && ret >= 0)
				take[i] = (uint64_t)ret < out_cap[i] ?
						  (uint32_t)ret : out_cap[i];
			body_len += take[i];
		}
		if (body_len) {
			size_t off = 0;

			body = malloc(body_len);
			if (!body)
				goto malformed;
			for (i = 0; i < syscall_args; i++)
				if (take[i]) {
					memcpy(body + off, outs[i], take[i]);
					off += take[i];
				}
		}
	}
	send_reply(req->id, ret, err, body, body_len);
	goto out;
malformed:
	mark_dead();
out:
	free(body);
	for (i = 0; i < syscall_args; i++) {
		free(blobs[i]);
		free(outs[i]);
	}
}

static void close_fd(int *fd)
{
	if (*fd != -1) {
		close(*fd);
		*fd = -1;
	}
}

static void handle_spawn(const struct request *req)
{
	struct cursor cur = { req->payload, req->length, 0 };
	uint32_t argc = 0, envc = 0, i;
	char **argv = NULL;
	char **envp = NULL;
	char *cwd = NULL;
	int in[2] = { -1, -1 };
	int out[2] = { -1, -1 };
	int err[2] = { -1, -1 };
	posix_spawn_file_actions_t actions;
	bool have_actions = false;
	int slot = -1;
	int rc = EIO;
	pid_t pid;
	uint8_t body[16];

	if (!cursor_u32(&cur, &argc) || argc < 1 || argc > max_arguments)
		goto invalid;
	argv = calloc((size_t)argc + 1, sizeof(char *));
	if (!argv)
		goto invalid;
	for (i = 0; i < argc; i++) {
		argv[i] = cursor_string(&cur);
		if (!argv[i])
			goto invalid;
	}
	cwd = cursor_string(&cur);
	if (!cwd || !cursor_u32(&cur, &envc) || envc > max_environment)
		goto invalid;
	envp = calloc((size_t)envc + 1, sizeof(char *));
	if (!envp)
		goto invalid;
	for (i = 0; i < envc; i++) {
		envp[i] = cursor_string(&cur);
		if (!envp[i] || !strchr(envp[i], '='))
			goto invalid;
	}
	if (!cursor_finished(&cur))
		goto invalid;

	pthread_mutex_lock(&children_mutex);
	for (i = 0; i < process_capacity; i++)
		if (!children[i].used) {
			children[i].used = true;
			children[i].pid = 0;
			slot = (int)i;
			break;
		}
	pthread_mutex_unlock(&children_mutex);
	if (slot < 0) {
		send_reply(req->id, -1, EAGAIN, NULL, 0);
		goto done;
	}

	if (pipe2(in, O_CLOEXEC) == -1 || pipe2(out, O_CLOEXEC) == -1 ||
	    pipe2(err, O_CLOEXEC) == -1) {
		rc = errno;
		goto spawn_failed;
	}
	rc = posix_spawn_file_actions_init(&actions);
	if (rc)
		goto spawn_failed;
	have_actions = true;
	if ((rc = posix_spawn_file_actions_adddup2(&actions, in[0], 0)) ||
	    (rc = posix_spawn_file_actions_adddup2(&actions, out[1], 1)) ||
	    (rc = posix_spawn_file_actions_adddup2(&actions, err[1], 2)) ||
	    (rc = posix_spawn_file_actions_addclose(&actions, in[1])) ||
	    (rc = posix_spawn_file_actions_addclose(&actions, out[0])) ||
	    (rc = posix_spawn_file_actions_addclose(&actions, err[0])) ||
	    (rc = posix_spawn_file_actions_addchdir_np(&actions, cwd)))
		goto spawn_failed;
	rc = posix_spawnp(&pid, argv[0], &actions, NULL, argv, envp);
	if (rc)
		goto spawn_failed;
	posix_spawn_file_actions_destroy(&actions);
	close_fd(&in[0]);
	close_fd(&out[1]);
	close_fd(&err[1]);
	pthread_mutex_lock(&children_mutex);
	children[slot].pid = pid;
	pthread_mutex_unlock(&children_mutex);
	store_u32(body, pid);
	store_u32(body + 4, in[1]);
	store_u32(body + 8, out[0]);
	store_u32(body + 12, err[0]);
	send_reply(req->id, 0, 0, body, sizeof(body));
	goto done;

spawn_failed:
	if (have_actions)
		posix_spawn_file_actions_destroy(&actions);
	close_fd(&in[0]);
	close_fd(&in[1]);
	close_fd(&out[0]);
	close_fd(&out[1]);
	close_fd(&err[0]);
	close_fd(&err[1]);
	pthread_mutex_lock(&children_mutex);
	children[slot].used = false;
	pthread_mutex_unlock(&children_mutex);
	send_reply(req->id, -1, rc > 0 ? (uint32_t)rc : EIO, NULL, 0);
	goto done;

invalid:
	send_reply(req->id, -1, EINVAL, NULL, 0);
done:
	if (argv)
		for (i = 0; i < argc; i++)
			free(argv[i]);
	if (envp)
		for (i = 0; i < envc; i++)
			free(envp[i]);
	free(argv);
	free(envp);
	free(cwd);
}

static void handle_reap(const struct request *req)
{
	uint32_t pid;
	int status = 0;
	pid_t r;
	int err;
	size_t i;
	uint8_t body[4];

	if (req->length != 4) {
		mark_dead();
		return;
	}
	pid = load_u32(req->payload);
	r = waitpid((pid_t)pid, &status, 0);
	err = errno;
	pthread_mutex_lock(&children_mutex);
	for (i = 0; i < process_capacity; i++)
		if (children[i].used && children[i].pid == (pid_t)pid)
			children[i].used = false;
	pthread_mutex_unlock(&children_mutex);
	if (r == -1) {
		send_reply(req->id, -1, err, NULL, 0);
	} else {
		store_u32(body, (uint32_t)status);
		send_reply(req->id, 0, 0, body, sizeof(body));
	}
}

static void *worker(void *unused)
{
	(void)unused;
	for (;;) {
		struct request req = ring_pop();

		switch (req.type) {
		case frame_syscall:
			handle_syscall(&req);
			break;
		case frame_spawn:
			handle_spawn(&req);
			break;
		case frame_reap:
			handle_reap(&req);
			break;
		}
		free(req.payload);
		ring_done();
	}
	return NULL;
}

static void serve(int fd)
{
	uint8_t hs[8];
	size_t i;

	conn.fd = fd;
	conn.dead = 0;
	if (read_all(fd, hs, sizeof(hs)) == -1 ||
	    load_u32(hs) != protocol_magic ||
	    load_u16(hs + 4) != protocol_version) {
		close(fd);
		conn.fd = -1;
		return;
	}
	if (write_all(fd, hs, sizeof(hs)) == -1) {
		close(fd);
		conn.fd = -1;
		return;
	}
	for (;;) {
		uint8_t frame[12];
		struct request req = { 0 };
		uint16_t flags;

		if (read_all(fd, frame, sizeof(frame)) == -1)
			break;
		req.length = load_u32(frame);
		req.id = load_u32(frame + 4);
		req.type = load_u16(frame + 8);
		flags = load_u16(frame + 10);
		if (flags != 0 || req.length > max_payload ||
		    (req.type != frame_syscall && req.type != frame_spawn &&
		     req.type != frame_reap))
			break;
		if (req.length) {
			req.payload = malloc(req.length);
			if (!req.payload)
				break;
			if (read_all(fd, req.payload, req.length) == -1) {
				free(req.payload);
				break;
			}
		}
		ring_push(req);
	}

	/* Disconnect cleanup, ordered deliberately. */
	conn.dead = 1;
	/* SIGKILL unblocks workers stuck in blocking read()/waitpid() on a
	 * child's pipes or exit. */
	pthread_mutex_lock(&children_mutex);
	for (i = 0; i < process_capacity; i++)
		if (children[i].used && children[i].pid > 0)
			kill(children[i].pid, SIGKILL);
	pthread_mutex_unlock(&children_mutex);
	/* Only close the fd once the ring is drained and every in-flight
	 * request has completed: a still-running worker could otherwise write
	 * its reply into a reused fd number. This ordering is load-bearing. */
	ring_drain();
	close(fd);
	conn.fd = -1;
	pthread_mutex_lock(&children_mutex);
	for (i = 0; i < process_capacity; i++)
		if (children[i].used) {
			int status;

			/* A spawn that was still in flight during the
			 * pre-drain kill pass completed after it; kill again
			 * (idempotent) or the waitpid below blocks forever. */
			kill(children[i].pid, SIGKILL);
			waitpid(children[i].pid, &status, 0);
			children[i].used = false;
		}
	pthread_mutex_unlock(&children_mutex);
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
	size_t i;

	signal(SIGPIPE, SIG_IGN);
	if (mount_if_needed("proc", "/proc", "proc") == -1 ||
	    mount_if_needed("sysfs", "/sys", "sysfs") == -1) {
		perror("mount");
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
	    listen(server, ring_capacity) == -1) {
		perror("vsock listener");
		return 1;
	}
	printf("linux-guest-agent: ready on vsock port %d\n", agent_port);
	for (;;) {
		int fd = accept4(server, NULL, NULL, SOCK_CLOEXEC);

		if (fd == -1) {
			if (errno != EINTR)
				perror("accept");
			continue;
		}
		serve(fd);
	}
}
