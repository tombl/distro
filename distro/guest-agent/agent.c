/* Guest agent (protocol v4): a dumb syscall executor.
 *
 * The host opens one connection to the session port plus up to `max_lanes`
 * lanes on the lane port. A lane carries strictly serial request/reply
 * exchanges served by a dedicated thread created when the lane connects, so
 * there is no request queue, no reply multiplexing, and no shared write path:
 * message sizes are fully determined by the request, and the kernel does all
 * the scheduling.
 *
 * The session connection carries no requests. Its only job is to be a death
 * signal that cannot be stuck behind a blocked syscall. Each session runs in
 * its own process, so EOF tears down its threads and descriptors atomically;
 * that process's parent, a per-session keeper, then kills and reaps the
 * remaining descendants before PID 1 accepts the next session.
 *
 * See distro/guest-agent/protocol.md for the frozen contract.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <dirent.h>
#include <linux/vm_sockets.h>
#include <unistd.h>

enum {
	session_port = 1024,
	lane_port = 1025,
	protocol_magic = 0x584e4c54,
	protocol_version = 4,
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
	req_spawn_terminal = 4,
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

static bool cursor_u16(struct cursor *cursor, uint16_t *out)
{
	if (cursor->length - cursor->offset < 2)
		return false;
	*out = load_u16(cursor->data + cursor->offset);
	cursor->offset += 2;
	return true;
}

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

static const char *environment_path(char *const envp[])
{
	uint32_t i;

	for (i = 0; envp[i]; i++)
		if (!strncmp(envp[i], "PATH=", 5))
			return envp[i] + 5;
	return "/usr/local/bin:/bin:/usr/bin";
}

/* musl's posix_spawnp searches the agent's process environment, not envp.
 * Try each supplied PATH entry with posix_spawn instead: file actions run
 * before exec, so relative entries are correctly resolved after chdir. */
static int spawn_with_path(pid_t *pid, const posix_spawn_file_actions_t *actions,
			   const posix_spawnattr_t *attributes,
			   char *const argv[], char *const envp[])
{
	const char *file = argv[0];
	const char *path;
	bool seen_eacces = false;
	size_t file_length;

	if (!*file)
		return ENOENT;
	if (strchr(file, '/'))
		return posix_spawn(pid, file, actions, attributes, argv, envp);
	file_length = strnlen(file, NAME_MAX + 1);
	if (file_length > NAME_MAX)
		return ENAMETOOLONG;

	path = environment_path(envp);
	for (;;) {
		const char *separator = strchr(path, ':');
		size_t directory_length = separator ? (size_t)(separator - path) : strlen(path);
		char candidate[max_string + NAME_MAX + 2];
		int error;

		if (directory_length + (directory_length != 0) + file_length + 1 >
		    sizeof(candidate))
			return ENAMETOOLONG;
		memcpy(candidate, path, directory_length);
		if (directory_length)
			candidate[directory_length++] = '/';
		memcpy(candidate + directory_length, file, file_length + 1);

		error = posix_spawn(pid, candidate, actions, attributes, argv,
				    envp);
		if (!error)
			return 0;
		if (error == EACCES)
			seen_eacces = true;
		else if (error != ENOENT && error != ENOTDIR)
			return error;
		if (!separator)
			return seen_eacces ? EACCES : ENOENT;
		path = separator + 1;
	}
}

/* Allocates a pseudoterminal for a terminal spawn and sizes it before the
 * child can ask. The agent keeps only the master; the child opens the
 * subsidiary by name after setsid, which makes it the controlling terminal.
 * Returns an errno value. */
static int open_terminal(int *master, char *name, size_t name_size,
			 uint16_t rows, uint16_t columns)
{
	struct winsize size = { .ws_row = rows, .ws_col = columns };

	*master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
	if (*master == -1 || grantpt(*master) == -1 || unlockpt(*master) == -1)
		return errno;
	if (ioctl(*master, TIOCSWINSZ, &size) == -1)
		return errno;
	return ptsname_r(*master, name, name_size);
}

/* Spawn request body: { len u32 } then { argc u32 } argc x string,
 * string cwd, { envc u32 } envc x string. A terminal spawn's payload starts
 * with { rows u16, columns u16 }. The length prefix exists so a payload that
 * fails to parse is already consumed and can get an EINVAL reply without
 * desyncing the lane. */
static int serve_spawn(int fd, bool terminal)
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
	int master = -1;
	char terminal_name[32];
	uint16_t rows = 0, columns = 0;
	posix_spawn_file_actions_t actions;
	posix_spawnattr_t attributes;
	sigset_t default_signals;
	bool have_actions = false, have_attributes = false;
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

	if (terminal && (!cursor_u16(&cur, &rows) || !cursor_u16(&cur, &columns)))
		goto invalid;
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

	spawn_errno = posix_spawn_file_actions_init(&actions);
	if (spawn_errno)
		goto spawn_failed;
	have_actions = true;
	spawn_errno = posix_spawnattr_init(&attributes);
	if (spawn_errno)
		goto spawn_failed;
	have_attributes = true;
	/* The agent ignores SIGPIPE so a vanished host cannot kill it; commands
	 * get the default, or every pipeline in a shell would report EPIPE. A
	 * terminal command leads its own session, and opening the terminal
	 * without O_NOCTTY there makes it the controlling terminal. */
	sigemptyset(&default_signals);
	sigaddset(&default_signals, SIGPIPE);
	if ((spawn_errno = posix_spawnattr_setsigdefault(&attributes,
							 &default_signals)) ||
	    (spawn_errno = posix_spawnattr_setflags(
		     &attributes, POSIX_SPAWN_SETSIGDEF |
					  (terminal ? POSIX_SPAWN_SETSID : 0))))
		goto spawn_failed;
	if (terminal) {
		if ((spawn_errno = open_terminal(&master, terminal_name,
						 sizeof(terminal_name), rows,
						 columns)) ||
		    (spawn_errno = posix_spawn_file_actions_addopen(
			     &actions, 0, terminal_name, O_RDWR, 0)) ||
		    (spawn_errno = posix_spawn_file_actions_adddup2(&actions, 0, 1)) ||
		    (spawn_errno = posix_spawn_file_actions_adddup2(&actions, 0, 2)))
			goto spawn_failed;
	} else {
		if (pipe2(in, O_CLOEXEC) == -1 || pipe2(out, O_CLOEXEC) == -1 ||
		    pipe2(err, O_CLOEXEC) == -1) {
			spawn_errno = errno;
			goto spawn_failed;
		}
		if ((spawn_errno = posix_spawn_file_actions_adddup2(&actions, in[0], 0)) ||
		    (spawn_errno = posix_spawn_file_actions_adddup2(&actions, out[1], 1)) ||
		    (spawn_errno = posix_spawn_file_actions_adddup2(&actions, err[1], 2)) ||
		    (spawn_errno = posix_spawn_file_actions_addclose(&actions, in[1])) ||
		    (spawn_errno = posix_spawn_file_actions_addclose(&actions, out[0])) ||
		    (spawn_errno = posix_spawn_file_actions_addclose(&actions, err[0])))
			goto spawn_failed;
	}
	if ((spawn_errno = posix_spawn_file_actions_addchdir_np(&actions, cwd)))
		goto spawn_failed;
	/* Publish the pid before the sole reaper can classify a fast exit. */
	pthread_mutex_lock(&children_mutex);
	spawn_errno = spawn_with_path(&pid, &actions, &attributes, argv, envp);
	if (!spawn_errno) {
		children[slot].pid = pid;
		pthread_cond_broadcast(&children_changed);
	}
	pthread_mutex_unlock(&children_mutex);
	if (spawn_errno)
		goto spawn_failed;
	posix_spawn_file_actions_destroy(&actions);
	posix_spawnattr_destroy(&attributes);
	store_u32(body, (uint32_t)pid);
	if (terminal) {
		store_u32(body + 4, (uint32_t)master);
		if (write_reply(fd, 0, 0) || write_all(fd, body, 8))
			goto out;
		rc = 0;
		goto out;
	}
	close_fd(&in[0]);
	close_fd(&out[1]);
	close_fd(&err[1]);
	store_u32(body + 4, (uint32_t)in[1]);
	store_u32(body + 8, (uint32_t)out[0]);
	store_u32(body + 12, (uint32_t)err[0]);
	if (write_reply(fd, 0, 0) || write_all(fd, body, sizeof(body)))
		goto out;
	rc = 0;
	goto out;

spawn_failed:
	/* A spawn errno alone does not identify whether the executable or working
	 * directory is incompatible with the mounted system root. Keep this narrow
	 * diagnostic on the guest console so an embedder can repair its image. */
	fprintf(stderr, "linux-guest-agent: spawning %s in %s: %s\n",
		argv && argv[0] ? argv[0] : "(invalid)", cwd ? cwd : "(invalid)",
		strerror(spawn_errno));
	if (have_actions)
		posix_spawn_file_actions_destroy(&actions);
	if (have_attributes)
		posix_spawnattr_destroy(&attributes);
	close_fd(&master);
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
		case req_spawn_terminal:
			if (serve_spawn(fd, kind == req_spawn_terminal))
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

enum { session_stack_size = 64 * 1024 };
static _Alignas(16) char keeper_stack[session_stack_size];
static _Alignas(16) char session_stack[session_stack_size];

struct session_worker_args {
	int fd;
	int session_listener;
};

static int session_worker(void *opaque)
{
	struct session_worker_args *args = opaque;
	pthread_attr_t worker_attr;
	pthread_t reaper;
	int lane_listener, rc;

	/* Adopt descendants orphaned by commands so the session's reaper can
	 * collect them while the session is still alive. */
	if (prctl(PR_SET_CHILD_SUBREAPER, 1) == -1)
		_exit(1);
	lane_listener = listener(lane_port, max_lanes);
	if (lane_listener == -1)
		_exit(1);
	rc = pthread_attr_init(&worker_attr);
	if (!rc)
		rc = pthread_attr_setdetachstate(&worker_attr,
					      PTHREAD_CREATE_DETACHED);
	if (!rc)
		rc = pthread_create(&reaper, NULL, reap_children, NULL);
	if (rc)
		_exit(1);
	if (handshake(args->fd))
		_exit(0);
	rc = serve_session(args->fd, lane_listener, &worker_attr);
	_exit(rc ? 1 : 0);
}

static pid_t parent_pid(const char *pid)
{
	char path[32], stat[512], *end;
	ssize_t length;
	long ppid;
	int fd;

	if (snprintf(path, sizeof(path), "/proc/%s/stat", pid) >= (int)sizeof(path))
		return -1;
	fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd == -1)
		return -1;
	length = read(fd, stat, sizeof(stat) - 1);
	close(fd);
	if (length <= 0)
		return -1;
	stat[length] = 0;
	/* "pid (comm) state ppid ...", where comm may itself contain ')'. */
	end = strrchr(stat, ')');
	if (!end || sscanf(end + 1, " %*c %ld", &ppid) != 1)
		return -1;
	return (pid_t)ppid;
}

/* SIGKILLs every process this subreaper has adopted until none remain. A
 * killed process's own children are adopted here in turn, so the loop covers
 * the whole subtree whatever sessions and process groups commands created. */
static int kill_descendants(void)
{
	pid_t self = getpid();

	for (;;) {
		DIR *proc = opendir("/proc");
		struct dirent *entry;
		pid_t waited;

		if (!proc)
			return -1;
		while ((entry = readdir(proc)))
			if (entry->d_name[0] >= '1' && entry->d_name[0] <= '9' &&
			    parent_pid(entry->d_name) == self)
				kill((pid_t)atoi(entry->d_name), SIGKILL);
		closedir(proc);
		do
			waited = waitpid(-1, NULL, 0);
		while (waited == -1 && errno == EINTR);
		if (waited == -1)
			return errno == ECHILD ? 0 : -1;
		while (waitpid(-1, NULL, WNOHANG) > 0)
			;
	}
}

/* Each session runs under a keeper: a subreaper parent that outlives the
 * session worker. Commands may leave the session's process group, and a
 * terminal command leads its own session, so neither can identify them once
 * the worker is gone; instead its exit hands every surviving descendant to
 * the keeper, which kills them before PID 1 accepts another session. */
static int session_keeper(void *opaque)
{
	struct session_worker_args *args = opaque;
	pid_t worker, waited;
	int status;

	/* Keep the session out of PID 1's process group, so no signal aimed at
	 * /init's group reaches it. */
	if (setpgid(0, 0) == -1 || prctl(PR_SET_CHILD_SUBREAPER, 1) == -1)
		_exit(1);
	close(args->session_listener);
	args->session_listener = -1;
	worker = clone(session_worker, session_stack + session_stack_size,
		       SIGCHLD, args);
	if (worker == -1)
		_exit(1);
	close(args->fd);
	do
		waited = waitpid(worker, &status, 0);
	while (waited == -1 && errno == EINTR);
	if (waited == -1 || kill_descendants())
		_exit(1);
	_exit(WIFEXITED(status) ? WEXITSTATUS(status) : 1);
}

static int mount_if_needed(const char *source, const char *target,
			   const char *type)
{
	if (mount(source, target, type, 0, NULL) == -1 && errno != EBUSY)
		return -1;
	return 0;
}

enum {
	erofs_super_offset = 1024,
	erofs_volume_name_offset = 64,
	erofs_probe_size = 80,
	erofs_magic = 0xe0f5e1e2,
	ext4_super_offset = 1024,
	ext4_magic_offset = 56,
	ext4_volume_name_offset = 120,
	ext4_probe_size = 136,
	ext4_magic = 0xef53,
};

enum root_filesystem {
	root_filesystem_none,
	root_filesystem_erofs,
	root_filesystem_ext4,
};

struct system_root {
	char device[32];
	enum root_filesystem filesystem;
};

static enum root_filesystem probe_system_root(const char *device)
{
	static const uint8_t label[16] = "LOWLAND_ROOT";
	uint8_t super[ext4_probe_size];
	ssize_t length;
	int fd;

	fd = open(device, O_RDONLY | O_CLOEXEC);
	if (fd == -1)
		return false;
	do
		length = pread(fd, super, sizeof(super), erofs_super_offset);
	while (length == -1 && errno == EINTR);
	close(fd);
	if (length < (ssize_t)erofs_probe_size)
		return root_filesystem_none;
	if (load_u32(super) == erofs_magic &&
	    !memcmp(super + erofs_volume_name_offset, label, sizeof(label)))
		return root_filesystem_erofs;
	if (length >= (ssize_t)ext4_probe_size &&
	    load_u16(super + ext4_magic_offset) == ext4_magic &&
	    !memcmp(super + ext4_volume_name_offset, label, sizeof(label)))
		return root_filesystem_ext4;
	return root_filesystem_none;
}

static int find_system_root(struct system_root *root)
{
	int attempt;

	for (attempt = 0; attempt < 100; attempt++) {
		struct system_root found = { 0 };
		int roots = 0;
		char suffix;

		for (suffix = 'a'; suffix <= 'z'; suffix++) {
			char device[sizeof(root->device)];
			enum root_filesystem filesystem;
			int length = snprintf(device, sizeof(device), "/dev/vd%c",
					      suffix);

			if (length < 0 || (size_t)length >= sizeof(device)) {
				errno = ENAMETOOLONG;
				return -1;
			}
			filesystem = probe_system_root(device);
			if (filesystem == root_filesystem_none)
				continue;
			found.filesystem = filesystem;
			memcpy(found.device, device, sizeof(found.device));
			roots++;
		}
		if (roots > 1) {
			errno = EEXIST;
			return -1;
		}
		if (roots == 1) {
			*root = found;
			return 0;
		}
		usleep(100000);
	}
	errno = ENODEV;
	return -1;
}

static int make_directory(const char *path, mode_t mode)
{
	if (mkdir(path, mode) == -1 && errno != EEXIST)
		return -1;
	return 0;
}

static int root_read_only(const struct system_root *root, bool *read_only)
{
	int fd, error, value = 0;

	if (root->filesystem == root_filesystem_erofs) {
		*read_only = true;
		return 0;
	}
	fd = open(root->device, O_RDONLY | O_CLOEXEC);
	if (fd == -1)
		return -1;
	error = ioctl(fd, BLKROGET, &value);
	close(fd);
	*read_only = value;
	return error == -1 ? -1 : 0;
}

/* A writable ext4 root is persistent and mounts read-write directly. A
 * read-only root, either EROFS or a filesystem on a read-only block device,
 * always sits beneath a temporary OverlayFS upper layer: the system then
 * behaves like a normal writable root for the lifetime of a boot.
 *
 * An ext4 image that was last mounted read-write and never unmounted still
 * needs journal recovery, and ext4 refuses to replay a journal on a read-only
 * device. The lower layer is never written, so mount it with norecovery: the
 * root is then the filesystem as of its last journal checkpoint, and changes
 * that were only committed to the journal are not visible. */
static int mount_system_root(const struct system_root *root)
{
	bool ext4 = root->filesystem == root_filesystem_ext4;
	const char *type = ext4 ? "ext4" : "erofs";
	bool read_only;

	if (root_read_only(root, &read_only))
		return -1;
	if (!read_only)
		return mount(root->device, "/mnt", type, 0, NULL);
	if (make_directory("/lower", 0755) ||
	    make_directory("/overlay", 0755) ||
	    mount(root->device, "/lower", type, MS_RDONLY,
		  ext4 ? "norecovery" : NULL) == -1 ||
	    mount("tmpfs", "/overlay", "tmpfs", 0, NULL) == -1 ||
	    make_directory("/overlay/upper", 0755) ||
	    make_directory("/overlay/work", 0755) ||
	    mount("overlay", "/mnt", "overlay", 0,
		  "lowerdir=/lower,upperdir=/overlay/upper,workdir=/overlay/work") == -1)
		return -1;
	return 0;
}

/* Without a console the kernel starts PID 1 with no standard descriptors.
 * Hold them open on /dev/null so later descriptors never take their place: a
 * spawned child's stdio pipes allocated there would be clobbered by its own
 * dup2 and close file actions. */
static int reserve_standard_fds(void)
{
	int fd;

	for (;;) {
		fd = open("/dev/null", O_RDWR);
		if (fd == -1)
			return -1;
		if (fd > 2)
			return close(fd);
	}
}

static int prepare_system_root(void)
{
	struct system_root root;

	if (make_directory("/dev", 0755) ||
	    mount_if_needed("devtmpfs", "/dev", "devtmpfs") ||
	    reserve_standard_fds() ||
	    make_directory("/dev/pts", 0755) ||
	    mount_if_needed("devpts", "/dev/pts", "devpts") ||
	    make_directory("/proc", 0555) ||
	    mount_if_needed("proc", "/proc", "proc") ||
	    make_directory("/sys", 0555) ||
	    mount_if_needed("sysfs", "/sys", "sysfs"))
		return -1;

	if (find_system_root(&root)) {
		if (errno == EEXIST)
			fprintf(stderr, "linux-guest-agent: multiple filesystems are labeled LOWLAND_ROOT\n");
		else
			fprintf(stderr, "linux-guest-agent: no supported filesystem is labeled LOWLAND_ROOT\n");
		return -1;
	}
	if (mount_system_root(&root) ||
	    mount("tmpfs", "/mnt/run", "tmpfs", 0, NULL) == -1 ||
	    mount("tmpfs", "/mnt/tmp", "tmpfs", 0, NULL) == -1 ||
	    chmod("/mnt/tmp", 01777) == -1)
		return -1;

	if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) == -1 ||
	    mount("/dev", "/mnt/dev", NULL, MS_MOVE, NULL) == -1 ||
	    mount("/proc", "/mnt/proc", NULL, MS_MOVE, NULL) == -1 ||
	    mount("/sys", "/mnt/sys", NULL, MS_MOVE, NULL) == -1 ||
	    chdir("/mnt") == -1 ||
	    syscall(SYS_pivot_root, ".", "mnt") == -1 ||
	    chdir("/") == -1 || umount2("/mnt", MNT_DETACH) == -1)
		return -1;
	return 0;
}

static void child_exited(int signal)
{
	(void)signal;
}

static void check_system_init(pid_t pid)
{
	pid_t waited;
	int status;

	if (!pid)
		return;
	do
		waited = waitpid(pid, &status, WNOHANG);
	while (waited == -1 && errno == EINTR);
	if (!waited)
		return;
	if (waited == -1) {
		perror("linux-guest-agent: waiting for system init");
		abort();
	}
	fprintf(stderr, "linux-guest-agent: system init exited; powering off\n");
	/* The kernel's power-off path does not write back the page cache. */
	sync();
	if (reboot(RB_POWER_OFF) == -1) {
		perror("linux-guest-agent: powering off");
		abort();
	}
	abort();
}

static int start_system_init(pid_t *pid)
{
	char *const argv[] = { "/init", NULL };
	char *const envp[] = {
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		NULL,
	};
	int error;

	*pid = 0;
	if (access("/init", X_OK) == -1)
		return errno == ENOENT ? 0 : -1;
	error = posix_spawn(pid, "/init", NULL, NULL, argv, envp);
	if (error) {
		errno = error;
		return -1;
	}
	return 0;
}

int main(void)
{
	struct sigaction child_action = { .sa_handler = child_exited };
	pid_t system_init;
	int session_listener;

	signal(SIGPIPE, SIG_IGN);
	sigemptyset(&child_action.sa_mask);
	if (sigaction(SIGCHLD, &child_action, NULL) == -1) {
		perror("linux-guest-agent: installing SIGCHLD handler");
		return 1;
	}
	/* /proc remains load-bearing after the root transition: the host's
	 * realPath and FsFile.stat go through /proc/self/fd/N. */
	if (prepare_system_root()) {
		perror("linux-guest-agent: preparing system root");
		return 1;
	}
	/* A supervisor pthread would share PID 1's address space. The wasm kernel
	 * refuses to snapshot an address space with another user, so that would
	 * make every later clone of a session worker fail with EOPNOTSUPP. Keep PID
	 * 1 single-threaded and let SIGCHLD interrupt its blocking operations so it
	 * can check the system init here instead. */
	if (start_system_init(&system_init)) {
		perror("linux-guest-agent: starting system init");
		return 1;
	}
	session_listener = listener(session_port, 1);
	if (session_listener == -1) {
		perror("vsock listener");
		return 1;
	}
	printf("linux-guest-agent: ready on vsock port %d\n", session_port);
	for (;;) {
		int fd = accept4(session_listener, NULL, NULL, SOCK_CLOEXEC);
		pid_t keeper, waited;
		int status;
		struct session_worker_args args;

		if (fd == -1) {
			if (errno == EINTR)
				check_system_init(system_init);
			else
				perror("accept session");
			continue;
		}
		args = (struct session_worker_args) {
			.fd = fd,
			.session_listener = session_listener,
		};
		/* The keeper's exit means the session's worker and every one of
		 * its descendants are gone, so the next session starts clean. */
		keeper = clone(session_keeper, keeper_stack + session_stack_size,
			       SIGCHLD, &args);
		if (keeper == -1) {
			perror("clone session");
			close(fd);
			return 1;
		}
		close(fd);
		do {
			waited = waitpid(keeper, &status, 0);
			if (waited == -1 && errno == EINTR)
				check_system_init(system_init);
		} while (waited == -1 && errno == EINTR);
		if (waited == -1) {
			perror("wait session");
			return 1;
		}
		if (!WIFEXITED(status) || WEXITSTATUS(status)) {
			fprintf(stderr, "session worker failed\n");
			return 1;
		}
	}
}
