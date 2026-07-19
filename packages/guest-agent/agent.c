/* Guest agent (protocol v3): a dumb syscall executor.
 *
 * The host opens one connection to the session port plus up to `max_lanes`
 * lanes on the lane port. A lane carries strictly serial request/reply
 * exchanges served by a dedicated thread created when the lane connects, so
 * there is no request queue, no reply multiplexing, and no shared write path:
 * message sizes are fully determined by the request, and the kernel does all
 * the scheduling.
 *
 * The session connection carries no requests. Its only job is to be a death
 * signal that cannot be stuck behind a blocked syscall: when it reaches EOF
 * the main thread kills every child (which unblocks any lane stuck in a
 * pipe read), waits for the lanes to drain, reaps, and returns to accept()
 * so a fresh host can attach during development.
 *
 * See packages/guest-agent/protocol.md for the frozen contract.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
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
#include <sys/types.h>
#include <sys/wait.h>
#include <linux/vm_sockets.h>
#include <unistd.h>

enum {
	session_port = 1024,
	lane_port = 1025,
	protocol_magic = 0x584e4c54,
	protocol_version = 3,
	max_lanes = 64,
	max_blob = 128 * 1024,
	max_spawn_payload = 4 * 1024 * 1024,
	max_string = 4096,
	max_arguments = 256,
	max_environment = 256,
	process_capacity = 16,
};

enum request_kind {
	req_syscall = 1,
	req_spawn = 2,
	req_reap = 3,
};

enum arg_kind {
	arg_scalar = 0,
	arg_in_blob = 1,
	arg_out_full = 2,
	arg_out_ret = 3,
};

static struct {
	pid_t pid;
	bool used;
	bool reaped;
	int status;
} children[process_capacity];
static pthread_mutex_t children_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t children_changed = PTHREAD_COND_INITIALIZER;

static struct {
	pthread_mutex_t mutex;
	pthread_cond_t changed;
	int active_lanes;
} session = {
	.mutex = PTHREAD_MUTEX_INITIALIZER,
	.changed = PTHREAD_COND_INITIALIZER,
};

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

/* { ret i64, errno u32 }: the uniform reply head for all three requests. */
static int write_reply(int fd, int64_t ret, uint32_t err)
{
	uint8_t head[12];

	store_u64(head, (uint64_t)ret);
	store_u32(head + 8, err);
	return write_all(fd, head, sizeof(head));
}

struct cursor {
	const uint8_t *data;
	size_t length;
	size_t offset;
};

static bool cursor_u32(struct cursor *cursor, uint32_t *out)
{
	if (cursor->length - cursor->offset < 4)
		return false;
	*out = load_u32(cursor->data + cursor->offset);
	cursor->offset += 4;
	return true;
}

static char *cursor_string(struct cursor *cursor)
{
	uint32_t length;
	char *string;

	if (!cursor_u32(cursor, &length) || length > max_string ||
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

/* Syscall request body: { nr u32, arg_kinds u8[6], arg_values u64[6] } then
 * in-blob bytes in argument order. Returns -1 to end the lane: an in-blob
 * length beyond the cap means the stream itself cannot be trusted (semantic
 * problems get errno replies; the host validates nothing). */
static int serve_syscall(int fd)
{
	uint8_t hdr[58];
	unsigned long args[6] = { 0 };
	uint8_t *blobs[6] = { 0 };
	uint8_t *outs[6] = { 0 };
	uint32_t out_cap[6] = { 0 };
	uint8_t kinds[6];
	long nr, ret;
	uint32_t err;
	int i, rc = -1;

	if (read_all(fd, hdr, sizeof(hdr)))
		return -1;
	nr = (long)load_u32(hdr);
	for (i = 0; i < 6; i++) {
		uint64_t value = load_u64(hdr + 10 + 8 * i);

		kinds[i] = hdr[4 + i];
		switch (kinds[i]) {
		case arg_scalar:
			args[i] = (unsigned long)value;
			break;
		case arg_in_blob:
			if (value > max_blob)
				goto out;
			blobs[i] = malloc(value ? value : 1);
			if (!blobs[i])
				goto out;
			if (read_all(fd, blobs[i], value))
				goto out;
			args[i] = (unsigned long)(uintptr_t)blobs[i];
			break;
		case arg_out_full:
		case arg_out_ret:
			if (value > max_blob)
				goto out;
			outs[i] = calloc(value ? value : 1, 1);
			if (!outs[i])
				goto out;
			out_cap[i] = (uint32_t)value;
			args[i] = (unsigned long)(uintptr_t)outs[i];
			break;
		default:
			goto out;
		}
	}

	ret = (long)syscall(nr, args[0], args[1], args[2], args[3], args[4],
			    args[5]);
	err = ret == -1 ? (uint32_t)errno : 0;

	if (write_reply(fd, ret, err))
		goto out;
	if (ret != -1) {
		for (i = 0; i < 6; i++) {
			uint32_t take = 0;

			if (kinds[i] == arg_out_full)
				take = out_cap[i];
			else if (kinds[i] == arg_out_ret && ret >= 0)
				take = (uint64_t)ret < out_cap[i] ?
					       (uint32_t)ret : out_cap[i];
			if (take && write_all(fd, outs[i], take))
				goto out;
		}
	}
	rc = 0;
out:
	for (i = 0; i < 6; i++) {
		free(blobs[i]);
		free(outs[i]);
	}
	return rc;
}

static void close_fd(int *fd)
{
	if (*fd != -1) {
		close(*fd);
		*fd = -1;
	}
}

/* PID 1 owns every child, including descendants orphaned by commands. Keep
 * waitpid in exactly one thread so adopted children are discarded without
 * racing status delivery for children registered by the host protocol. */
static void *reap_children(void *unused)
{
	(void)unused;
	for (;;) {
		int status;
		pid_t pid = waitpid(-1, &status, 0);
		size_t i;

		if (pid == -1) {
			if (errno == EINTR)
				continue;
			if (errno == ECHILD) {
				pthread_mutex_lock(&children_mutex);
				while (true) {
					for (i = 0; i < process_capacity; i++)
						if (children[i].used &&
						    children[i].pid > 0 &&
						    !children[i].reaped)
							break;
					if (i != process_capacity)
						break;
					pthread_cond_wait(&children_changed,
							  &children_mutex);
				}
				pthread_mutex_unlock(&children_mutex);
				continue;
			}
			perror("waitpid");
			abort();
		}

		pthread_mutex_lock(&children_mutex);
		for (i = 0; i < process_capacity; i++)
			if (children[i].used && children[i].pid == pid) {
				children[i].status = status;
				children[i].reaped = true;
				break;
			}
		pthread_cond_broadcast(&children_changed);
		pthread_mutex_unlock(&children_mutex);
	}
}

/* Spawn request body: { len u32 } then { argc u32 } argc x string,
 * string cwd, { envc u32 } envc x string. The length prefix exists so a
 * payload that fails to parse is already consumed and can get an EINVAL
 * reply without desyncing the lane. */
static int serve_spawn(int fd)
{
	uint8_t len_bytes[4];
	uint8_t *payload = NULL;
	struct cursor cur;
	uint32_t len, argc = 0, envc = 0, i;
	char **argv = NULL;
	char **envp = NULL;
	char *cwd = NULL;
	int in[2] = { -1, -1 };
	int out[2] = { -1, -1 };
	int err[2] = { -1, -1 };
	posix_spawn_file_actions_t actions;
	bool have_actions = false;
	int slot = -1;
	int spawn_errno;
	pid_t pid;
	uint8_t body[16];
	int rc = -1;

	if (read_all(fd, len_bytes, sizeof(len_bytes)))
		return -1;
	len = load_u32(len_bytes);
	if (len > max_spawn_payload)
		return -1;
	payload = malloc(len ? len : 1);
	if (!payload)
		return -1;
	if (read_all(fd, payload, len))
		goto out;
	cur = (struct cursor){ payload, len, 0 };

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
	if (cur.offset != cur.length)
		goto invalid;

	pthread_mutex_lock(&children_mutex);
	for (i = 0; i < process_capacity; i++)
		if (!children[i].used) {
			children[i].used = true;
			children[i].pid = 0;
			children[i].reaped = false;
			children[i].status = 0;
			slot = (int)i;
			break;
		}
	pthread_mutex_unlock(&children_mutex);
	if (slot < 0) {
		rc = write_reply(fd, -1, EAGAIN);
		goto out;
	}

	if (pipe2(in, O_CLOEXEC) == -1 || pipe2(out, O_CLOEXEC) == -1 ||
	    pipe2(err, O_CLOEXEC) == -1) {
		spawn_errno = errno;
		goto spawn_failed;
	}
	spawn_errno = posix_spawn_file_actions_init(&actions);
	if (spawn_errno)
		goto spawn_failed;
	have_actions = true;
	if ((spawn_errno = posix_spawn_file_actions_adddup2(&actions, in[0], 0)) ||
	    (spawn_errno = posix_spawn_file_actions_adddup2(&actions, out[1], 1)) ||
	    (spawn_errno = posix_spawn_file_actions_adddup2(&actions, err[1], 2)) ||
	    (spawn_errno = posix_spawn_file_actions_addclose(&actions, in[1])) ||
	    (spawn_errno = posix_spawn_file_actions_addclose(&actions, out[0])) ||
	    (spawn_errno = posix_spawn_file_actions_addclose(&actions, err[0])) ||
	    (spawn_errno = posix_spawn_file_actions_addchdir_np(&actions, cwd)))
		goto spawn_failed;
	/* Publish the pid before the sole reaper can classify a fast exit. */
	pthread_mutex_lock(&children_mutex);
	spawn_errno = posix_spawnp(&pid, argv[0], &actions, NULL, argv, envp);
	if (!spawn_errno) {
		children[slot].pid = pid;
		pthread_cond_broadcast(&children_changed);
	}
	pthread_mutex_unlock(&children_mutex);
	if (spawn_errno)
		goto spawn_failed;
	posix_spawn_file_actions_destroy(&actions);
	close_fd(&in[0]);
	close_fd(&out[1]);
	close_fd(&err[1]);
	store_u32(body, (uint32_t)pid);
	store_u32(body + 4, (uint32_t)in[1]);
	store_u32(body + 8, (uint32_t)out[0]);
	store_u32(body + 12, (uint32_t)err[0]);
	if (write_reply(fd, 0, 0) || write_all(fd, body, sizeof(body)))
		goto out;
	rc = 0;
	goto out;

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
	pthread_cond_broadcast(&children_changed);
	pthread_mutex_unlock(&children_mutex);
	rc = write_reply(fd, -1, spawn_errno > 0 ? (uint32_t)spawn_errno : EIO);
	goto out;

invalid:
	rc = write_reply(fd, -1, EINVAL);
out:
	if (argv)
		for (i = 0; i < argc; i++)
			free(argv[i]);
	if (envp)
		for (i = 0; i < envc; i++)
			free(envp[i]);
	free(argv);
	free(envp);
	free(cwd);
	free(payload);
	return rc;
}

/* Reap request body: { pid u32 }. Blocks in waitpid until the child exits;
 * reply body on success is { status u32 } (raw wait status). */
static int serve_reap(int fd)
{
	uint8_t pid_bytes[4];
	uint8_t body[4];
	uint32_t pid;
	int status;
	size_t i;

	if (read_all(fd, pid_bytes, sizeof(pid_bytes)))
		return -1;
	pid = load_u32(pid_bytes);
	pthread_mutex_lock(&children_mutex);
	for (i = 0; i < process_capacity; i++)
		if (children[i].used && children[i].pid == (pid_t)pid)
			break;
	if (i == process_capacity) {
		pthread_mutex_unlock(&children_mutex);
		return write_reply(fd, -1, ECHILD);
	}
	while (!children[i].reaped)
		pthread_cond_wait(&children_changed, &children_mutex);
	status = children[i].status;
	children[i].used = false;
	pthread_cond_broadcast(&children_changed);
	pthread_mutex_unlock(&children_mutex);
	if (write_reply(fd, 0, 0))
		return -1;
	store_u32(body, (uint32_t)status);
	return write_all(fd, body, sizeof(body));
}

/* Handshake: 8 bytes { magic u32, version u16, reserved u16 }, echoed. */
static int handshake(int fd)
{
	uint8_t hs[8];

	if (read_all(fd, hs, sizeof(hs)) || load_u32(hs) != protocol_magic ||
	    load_u16(hs + 4) != protocol_version)
		return -1;
	return write_all(fd, hs, sizeof(hs));
}

static void serve_lane(int fd)
{
	if (handshake(fd))
		return;
	for (;;) {
		uint8_t kind;

		if (read_all(fd, &kind, 1))
			return;
		switch (kind) {
		case req_syscall:
			if (serve_syscall(fd))
				return;
			break;
		case req_spawn:
			if (serve_spawn(fd))
				return;
			break;
		case req_reap:
			if (serve_reap(fd))
				return;
			break;
		default:
			return;
		}
	}
}

static void *worker(void *fd_arg)
{
	int fd = (int)(intptr_t)fd_arg;

	serve_lane(fd);
	close(fd);
	pthread_mutex_lock(&session.mutex);
	session.active_lanes--;
	pthread_cond_broadcast(&session.changed);
	pthread_mutex_unlock(&session.mutex);
	return NULL;
}

static int accept_lane(int listener, const pthread_attr_t *worker_attr)
{
	pthread_t thread;
	int fd, rc;

	fd = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
	if (fd == -1)
		return errno == EINTR ? 0 : -1;

	pthread_mutex_lock(&session.mutex);
	if (session.active_lanes == max_lanes) {
		pthread_mutex_unlock(&session.mutex);
		close(fd);
		return 0;
	}
	session.active_lanes++;
	pthread_mutex_unlock(&session.mutex);

	rc = pthread_create(&thread, worker_attr, worker,
			    (void *)(intptr_t)fd);
	if (rc) {
		close(fd);
		pthread_mutex_lock(&session.mutex);
		session.active_lanes--;
		pthread_cond_broadcast(&session.changed);
		pthread_mutex_unlock(&session.mutex);
		errno = rc;
		return -1;
	}
	return 0;
}

static int serve_session(int fd, int lane_listener,
			 const pthread_attr_t *worker_attr)
{
	struct pollfd fds[] = {
		{ .fd = fd, .events = POLLIN },
		{ .fd = lane_listener, .events = POLLIN },
	};

	for (;;) {
		int rc = poll(fds, sizeof(fds) / sizeof(fds[0]), -1);

		if (rc == -1) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		/* Session death wins over a simultaneously arriving lane. */
		if (fds[0].revents)
			return 0;
		if (fds[1].revents & POLLIN) {
			if (accept_lane(lane_listener, worker_attr))
				return -1;
		} else if (fds[1].revents) {
			errno = EIO;
			return -1;
		}
	}
}

static void teardown(void)
{
	size_t i;

	/* SIGKILL first: this is what unblocks lanes stuck in a pipe read or
	 * waitpid, so it must happen before waiting for them. */
	pthread_mutex_lock(&children_mutex);
	for (i = 0; i < process_capacity; i++)
		if (children[i].used && children[i].pid > 0 &&
		    !children[i].reaped)
			kill(children[i].pid, SIGKILL);
	pthread_mutex_unlock(&children_mutex);

	pthread_mutex_lock(&session.mutex);
	while (session.active_lanes)
		pthread_cond_wait(&session.changed, &session.mutex);
	pthread_mutex_unlock(&session.mutex);

	/* All lanes have drained, so the table is quiescent. A spawn that was
	 * still in flight during the kill pass completed after it; kill again
	 * (idempotent), then let the sole reaper collect every remaining status. */
	pthread_mutex_lock(&children_mutex);
	for (i = 0; i < process_capacity; i++)
		if (children[i].used && !children[i].reaped)
			kill(children[i].pid, SIGKILL);
	for (i = 0; i < process_capacity; i++) {
		while (children[i].used && !children[i].reaped)
			pthread_cond_wait(&children_changed, &children_mutex);
		children[i].used = false;
	}
	pthread_cond_broadcast(&children_changed);
	pthread_mutex_unlock(&children_mutex);

}

static int listener(unsigned port, int backlog)
{
	struct sockaddr_vm address = {
		.svm_family = AF_VSOCK,
		.svm_cid = VMADDR_CID_ANY,
		.svm_port = port,
	};
	int fd = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);

	if (fd == -1 ||
	    bind(fd, (struct sockaddr *)&address, sizeof(address)) == -1 ||
	    listen(fd, backlog) == -1)
		return -1;
	return fd;
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
	pthread_attr_t worker_attr;
	pthread_t reaper;
	int session_listener, lane_listener, rc;

	signal(SIGPIPE, SIG_IGN);
	rc = pthread_create(&reaper, NULL, reap_children, NULL);
	if (rc) {
		errno = rc;
		perror("pthread reaper");
		return 1;
	}
	/* /proc is load-bearing: the host's realPath and FsFile.stat go
	 * through /proc/self/fd/N. */
	if (mount_if_needed("proc", "/proc", "proc") == -1 ||
	    mount_if_needed("sysfs", "/sys", "sysfs") == -1) {
		perror("mount");
		return 1;
	}
	session_listener = listener(session_port, 1);
	lane_listener = listener(lane_port, max_lanes);
	if (session_listener == -1 || lane_listener == -1) {
		perror("vsock listener");
		return 1;
	}
	rc = pthread_attr_init(&worker_attr);
	if (!rc)
		rc = pthread_attr_setdetachstate(&worker_attr,
					      PTHREAD_CREATE_DETACHED);
	if (rc) {
		errno = rc;
		perror("pthread worker attributes");
		return 1;
	}
	printf("linux-guest-agent: ready on vsock port %d\n", session_port);
	for (;;) {
		int fd = accept4(session_listener, NULL, NULL, SOCK_CLOEXEC);

		if (fd == -1) {
			if (errno != EINTR)
				perror("accept session");
			continue;
		}
		if (handshake(fd) == 0) {
			rc = serve_session(fd, lane_listener, &worker_attr);
			teardown();
			if (rc) {
				perror("serve session");
				close(fd);
				return 1;
			}
		}
		close(fd);
	}
}
