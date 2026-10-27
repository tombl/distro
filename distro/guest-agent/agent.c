/* Guest agent (protocol v6): a dumb syscall executor, and PID 1.
 *
 * The kernel runs the agent as /init from its initramfs. The host opens one
 * connection to the session port plus up to `max_lanes` lanes on the lane
 * port. A lane carries strictly serial request/reply exchanges served by a
 * dedicated thread created when the lane connects, so there is no request
 * queue, no reply multiplexing, and no shared write path: message sizes are
 * fully determined by the request, and the kernel does all the scheduling.
 *
 * The session connection carries no requests. Its only job is to be a death
 * signal that cannot be stuck behind a blocked syscall. Each session runs in
 * its own process, so EOF tears down its threads and descriptors atomically;
 * that process's parent, a per-session keeper, then kills and reaps the
 * remaining descendants before PID 1 accepts the next session.
 *
 * The agent knows no filesystems. The host mounts everything with ordinary
 * syscalls, and a switch_root request has PID 1 enter /sysroot between two
 * sessions, then start and supervise the host's init.
 *
 * See distro/guest-agent/protocol.md for the frozen contract.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mntent.h>
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
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <dirent.h>
#include <time.h>
#include <linux/vm_sockets.h>
#include <unistd.h>

enum {
	session_port = 1024,
	lane_port = 1025,
	protocol_magic = 0x584e4c54,
	protocol_version = 6,
	max_lanes = 64,
	max_blob = 128 * 1024,
	max_spawn_payload = 4 * 1024 * 1024,
	max_file_actions = 64,
	/* Fits an empty pipe on any page size, so handing it to PID 1 never
	 * blocks. */
	max_init_payload = 32 * 1024,
	max_string = 4096,
	max_arguments = 256,
	max_environment = 256,
	process_capacity = 16,
	shutdown_grace_ms = 3000,
};

enum request_kind {
	req_syscall = 1,
	req_spawn = 2,
	req_reap = 3,
	req_switch_root = 5,
};

/* A spawn's flags: POSIX_SPAWN_SETSID, and POSIX_SPAWN_SETSIGDEF for every
 * signal. */
enum spawn_flag {
	spawn_setsid = 1,
	spawn_default_signals = 2,
};

enum file_action {
	action_dup2 = 1,
	action_open = 2,
	action_close = 3,
};

/* A session worker's exit status, passed on by its keeper: the host asked
 * PID 1 to enter /sysroot once the session has ended. */
enum { session_exit_switch_root = 3 };

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
	/* Where a validated switch_root request sends its init to PID 1. */
	int init_pipe;
	bool switch_root_requested;
} session = {
	.mutex = PTHREAD_MUTEX_INITIALIZER,
	.changed = PTHREAD_COND_INITIALIZER,
	.init_pipe = -1,
};

/* PID 1's state. Sessions are clones of PID 1, so they see a copy as of the
 * moment their session started. */
static bool root_switched;
static pid_t init_pid;
static sigset_t original_mask;

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

/* { ret i64, errno u32 }: the uniform reply head for every request. */
static int write_reply(int fd, int64_t ret, uint32_t err)
{
	uint8_t head[12];

	store_u64(head, (uint64_t)ret);
	store_u32(head + 8, err);
	return write_all(fd, head, sizeof(head));
}

/* Reads a { len u32 } prefixed payload of at most `max` bytes. Returns NULL
 * when the lane can no longer be trusted. */
static uint8_t *read_payload(int fd, uint32_t max, uint32_t *length)
{
	uint8_t len_bytes[4];
	uint8_t *payload;

	if (read_all(fd, len_bytes, sizeof(len_bytes)))
		return NULL;
	*length = load_u32(len_bytes);
	if (*length > max)
		return NULL;
	payload = malloc(*length ? *length : 1);
	if (payload && read_all(fd, payload, *length)) {
		free(payload);
		return NULL;
	}
	return payload;
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

/* A command to start: the head of a spawn payload, and a switch root's init. */
struct command {
	uint32_t argc, envc;
	char **argv;
	char *cwd;
	char **envp;
};

static void free_command(struct command *command)
{
	uint32_t i;

	if (command->argv)
		for (i = 0; i < command->argc; i++)
			free(command->argv[i]);
	if (command->envp)
		for (i = 0; i < command->envc; i++)
			free(command->envp[i]);
	free(command->argv);
	free(command->envp);
	free(command->cwd);
	*command = (struct command){ 0 };
}

/* Parses { argc u32 } argc x string, string cwd, { envc u32 } envc x string.
 * False means the payload is invalid; free the command either way. */
static bool parse_command(struct cursor *cur, struct command *command)
{
	uint32_t i;

	*command = (struct command){ 0 };
	if (!cursor_u32(cur, &command->argc) || command->argc < 1 ||
	    command->argc > max_arguments)
		return false;
	command->argv = calloc((size_t)command->argc + 1, sizeof(char *));
	if (!command->argv)
		return false;
	for (i = 0; i < command->argc; i++) {
		command->argv[i] = cursor_string(cur);
		if (!command->argv[i])
			return false;
	}
	command->cwd = cursor_string(cur);
	if (!command->cwd || !cursor_u32(cur, &command->envc) ||
	    command->envc > max_environment)
		return false;
	command->envp = calloc((size_t)command->envc + 1, sizeof(char *));
	if (!command->envp)
		return false;
	for (i = 0; i < command->envc; i++) {
		command->envp[i] = cursor_string(cur);
		if (!command->envp[i] || !strchr(command->envp[i], '='))
			return false;
	}
	return true;
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

/* The session worker owns every child, including descendants orphaned by
 * commands. Keep waitpid in exactly one thread so adopted children are
 * discarded without racing status delivery for children registered by the
 * host protocol. */
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

/* Adds a spawn's file actions: { count u32 } then, per action, { op u32 }
 * and its operands. Returns 0, an errno value from posix_spawn, or -1 when
 * the list is malformed. */
static int add_file_actions(struct cursor *cur,
			    posix_spawn_file_actions_t *actions)
{
	uint32_t count, i;

	if (!cursor_u32(cur, &count) || count > max_file_actions)
		return -1;
	for (i = 0; i < count; i++) {
		uint32_t op, fd, newfd, oflag, mode;
		char *path;
		int error;

		if (!cursor_u32(cur, &op))
			return -1;
		switch (op) {
		case action_dup2:
			if (!cursor_u32(cur, &fd) || !cursor_u32(cur, &newfd))
				return -1;
			error = posix_spawn_file_actions_adddup2(actions, (int)fd,
								 (int)newfd);
			break;
		case action_open:
			if (!cursor_u32(cur, &newfd) || !cursor_u32(cur, &oflag) ||
			    !cursor_u32(cur, &mode) || !(path = cursor_string(cur)))
				return -1;
			error = posix_spawn_file_actions_addopen(
				actions, (int)newfd, path, (int)oflag, (mode_t)mode);
			free(path);
			break;
		case action_close:
			if (!cursor_u32(cur, &fd))
				return -1;
			error = posix_spawn_file_actions_addclose(actions, (int)fd);
			break;
		default:
			return -1;
		}
		if (error)
			return error;
	}
	return 0;
}

/* Spawn request body: { len u32 } then the command, { flags u32 }, and the
 * file actions. The child changes to cwd, then runs the file actions in order
 * on descriptors the host made. The length prefix exists so a payload that
 * fails to parse is already consumed and can get an EINVAL reply without
 * desyncing the lane. */
static int serve_spawn(int fd)
{
	uint8_t *payload;
	struct cursor cur;
	uint32_t len, flags, i;
	struct command command = { 0 };
	posix_spawn_file_actions_t actions;
	posix_spawnattr_t attributes;
	sigset_t all;
	bool have_actions = false, have_attributes = false;
	int slot = -1;
	int spawn_errno;
	pid_t pid;
	uint8_t body[4];
	int rc = -1;

	payload = read_payload(fd, max_spawn_payload, &len);
	if (!payload)
		return -1;
	cur = (struct cursor){ payload, len, 0 };

	if (!parse_command(&cur, &command) || !cursor_u32(&cur, &flags) ||
	    flags & ~(spawn_setsid | spawn_default_signals))
		goto invalid;
	spawn_errno = posix_spawn_file_actions_init(&actions);
	if (spawn_errno)
		goto spawn_failed;
	have_actions = true;
	/* chdir first, so relative paths in the file actions name the files a
	 * shell's redirections would. */
	spawn_errno = posix_spawn_file_actions_addchdir_np(&actions, command.cwd);
	if (!spawn_errno) {
		spawn_errno = add_file_actions(&cur, &actions);
		if (spawn_errno == -1 || cur.offset != cur.length)
			goto invalid;
	}
	if (spawn_errno)
		goto spawn_failed;
	spawn_errno = posix_spawnattr_init(&attributes);
	if (spawn_errno)
		goto spawn_failed;
	have_attributes = true;
	/* The agent ignores SIGPIPE so a vanished host cannot kill it; with
	 * default signals a command does not inherit that, or every pipeline in
	 * a shell would report EPIPE. */
	sigfillset(&all);
	if ((spawn_errno = posix_spawnattr_setsigdefault(&attributes, &all)) ||
	    (spawn_errno = posix_spawnattr_setflags(
		     &attributes,
		     (flags & spawn_setsid ? POSIX_SPAWN_SETSID : 0) |
			     (flags & spawn_default_signals ? POSIX_SPAWN_SETSIGDEF :
							      0))))
		goto spawn_failed;

	/* Publish the pid before the sole reaper can classify a fast exit. */
	pthread_mutex_lock(&children_mutex);
	for (i = 0; i < process_capacity; i++)
		if (!children[i].used) {
			slot = (int)i;
			break;
		}
	if (slot < 0) {
		spawn_errno = EAGAIN;
	} else {
		spawn_errno = spawn_with_path(&pid, &actions, &attributes,
					      command.argv, command.envp);
		if (!spawn_errno) {
			children[slot] = (typeof(children[slot])){ .used = true,
								   .pid = pid };
			pthread_cond_broadcast(&children_changed);
		}
	}
	pthread_mutex_unlock(&children_mutex);
	if (spawn_errno)
		goto spawn_failed;
	store_u32(body, (uint32_t)pid);
	rc = write_reply(fd, 0, 0) || write_all(fd, body, sizeof(body)) ? -1 : 0;
	goto out;

spawn_failed:
	/* A spawn errno alone does not identify whether the executable or working
	 * directory is incompatible with the mounted system root. Keep this narrow
	 * diagnostic on the guest console so an embedder can repair its image. */
	fprintf(stderr, "linux-guest-agent: spawning %s in %s: %s\n",
		command.argv[0], command.cwd, strerror(spawn_errno));
	rc = write_reply(fd, -1, spawn_errno > 0 ? (uint32_t)spawn_errno : EIO);
	goto out;

invalid:
	rc = write_reply(fd, -1, EINVAL);
out:
	if (have_actions)
		posix_spawn_file_actions_destroy(&actions);
	if (have_attributes)
		posix_spawnattr_destroy(&attributes);
	free_command(&command);
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

/* Checks that /sysroot can become the root: a directory on another
 * filesystem than / whose dev, proc and sys are mount points. Returns an
 * errno value. */
static int check_sysroot(void)
{
	static const char *const required[] = { "/sysroot/dev", "/sysroot/proc",
						"/sysroot/sys" };
	struct stat root, sysroot, mount_point;
	size_t i;

	if (stat("/", &root) == -1 || stat("/sysroot", &sysroot) == -1)
		return errno;
	if (!S_ISDIR(sysroot.st_mode))
		return ENOTDIR;
	if (sysroot.st_dev == root.st_dev)
		return EINVAL;
	for (i = 0; i < sizeof(required) / sizeof(required[0]); i++) {
		if (stat(required[i], &mount_point) == -1)
			return errno;
		if (mount_point.st_dev == sysroot.st_dev)
			return EINVAL;
	}
	return 0;
}

/* Switch root request body: { len u32 } then, when len is nonzero, a command
 * naming the init that PID 1 starts in the new root. The session
 * validates /sysroot and hands the init to PID 1, which enters /sysroot once
 * the host has ended this session. PID 1 switches root once per boot. */
static int serve_switch_root(int fd)
{
	uint8_t *payload;
	uint8_t len_bytes[4];
	struct command init = { 0 };
	struct cursor cur;
	uint32_t len;
	int error = 0;

	payload = read_payload(fd, max_init_payload, &len);
	if (!payload)
		return -1;
	cur = (struct cursor){ payload, len, 0 };
	if (len && (!parse_command(&cur, &init) || cur.offset != len))
		error = EINVAL;
	if (len)
		free_command(&init);
	if (!error && root_switched)
		error = EBUSY;
	if (!error)
		error = check_sysroot();
	if (!error) {
		pthread_mutex_lock(&session.mutex);
		store_u32(len_bytes, len);
		if (session.switch_root_requested)
			error = EBUSY;
		else if (write_all(session.init_pipe, len_bytes, sizeof(len_bytes)) ||
			 write_all(session.init_pipe, payload, len))
			error = errno;
		else
			session.switch_root_requested = true;
		pthread_mutex_unlock(&session.mutex);
	}
	free(payload);
	return error ? write_reply(fd, -1, error) : write_reply(fd, 0, 0);
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
		case req_switch_root:
			if (serve_switch_root(fd))
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
	/* The read and write ends of the pipe that carries a switch_root
	 * request's init to PID 1. */
	int init_pipe[2];
};

static int session_worker(void *opaque)
{
	struct session_worker_args *args = opaque;
	pthread_attr_t worker_attr;
	pthread_t reaper;
	int lane_listener, rc;

	session.init_pipe = args->init_pipe[1];
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
	pthread_mutex_lock(&session.mutex);
	if (!rc && session.switch_root_requested)
		rc = session_exit_switch_root;
	_exit(rc == -1 ? 1 : rc);
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
 * the whole subtree whatever sessions and process groups commands created.
 *
 * Only one session runs at a time, so until PID 1 supervises an init every
 * process but PID 1 and this keeper descends from this session: kill(-1)
 * finds them all. That also covers a boot session, which moves /proc into
 * /sysroot before it ends. With an init, the session's own descendants are
 * found through /proc instead. */
static int kill_descendants(void)
{
	pid_t self = getpid();

	for (;;) {
		pid_t waited;

		if (!init_pid) {
			kill(-1, SIGKILL);
		} else {
			DIR *proc = opendir("/proc");
			struct dirent *entry;

			if (!proc)
				return -1;
			while ((entry = readdir(proc)))
				if (entry->d_name[0] >= '1' &&
				    entry->d_name[0] <= '9' &&
				    parent_pid(entry->d_name) == self)
					kill((pid_t)atoi(entry->d_name), SIGKILL);
			closedir(proc);
		}
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

	/* PID 1's signal handling is its own: a session dies of SIGTERM like
	 * any other process, and its commands start with nothing blocked. */
	signal(SIGCHLD, SIG_DFL);
	signal(SIGTERM, SIG_DFL);
	signal(SIGUSR1, SIG_DFL);
	signal(SIGUSR2, SIG_DFL);
	sigprocmask(SIG_SETMASK, &original_mask, NULL);
	/* Keep the session out of PID 1's process group, so no signal aimed at
	 * /init's group reaches it. */
	if (setpgid(0, 0) == -1 || prctl(PR_SET_CHILD_SUBREAPER, 1) == -1)
		_exit(1);
	close(args->session_listener);
	args->session_listener = -1;
	close(args->init_pipe[0]);
	worker = clone(session_worker, session_stack + session_stack_size,
		       SIGCHLD, args);
	if (worker == -1)
		_exit(1);
	close(args->fd);
	close(args->init_pipe[1]);
	do
		waited = waitpid(worker, &status, 0);
	while (waited == -1 && errno == EINTR);
	if (waited == -1 || kill_descendants())
		_exit(1);
	_exit(WIFEXITED(status) ? WEXITSTATUS(status) : 1);
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

/* The only boot step in C: every other mount is the host's. */
static int mount_dev(void)
{
	if ((mkdir("/dev", 0755) == -1 && errno != EEXIST) ||
	    (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) == -1 &&
	     errno != EBUSY))
		return -1;
	return reserve_standard_fds();
}

static int64_t monotonic_ms(void)
{
	struct timespec now;

	clock_gettime(CLOCK_MONOTONIC, &now);
	return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

/* Unmounts the mount table in reverse order, remounting read-only whatever
 * stays busy and always the root: umount -a -r. Every entry counts: the table
 * is read whole before anything is unmounted, however long it is. */
static void unmount_all(void)
{
	char **targets = NULL;
	size_t count = 0, capacity = 0;
	struct mntent *entry;
	FILE *mounts = setmntent("/proc/self/mounts", "re");

	if (!mounts) {
		perror("linux-guest-agent: reading mounts");
		return;
	}
	/* getmntent undoes the octal escapes, such as \040 for a space. */
	while ((entry = getmntent(mounts))) {
		if (count == capacity) {
			size_t grown = capacity ? capacity * 2 : 64;
			char **resized = realloc(targets, grown * sizeof(*targets));

			if (!resized)
				break;
			targets = resized;
			capacity = grown;
		}
		targets[count] = strdup(entry->mnt_dir);
		if (targets[count])
			count++;
	}
	endmntent(mounts);
	while (count--) {
		char *target = targets[count];

		if (strcmp(target, "/") && !umount2(target, 0)) {
			free(target);
			continue;
		}
		if (mount(NULL, target, NULL, MS_REMOUNT | MS_RDONLY, NULL) == -1 &&
		    errno != EINVAL && errno != EACCES)
			fprintf(stderr,
				"linux-guest-agent: remounting %s read-only: %s\n",
				target, strerror(errno));
		free(target);
	}
	free(targets);
}

/* BusyBox init's shutdown sequence: SIGTERM to everything, a grace period,
 * SIGKILL, then the filesystems, then the kernel. Every process descends
 * from PID 1, so once it has no children left nothing else is running. */
static void __attribute__((noreturn)) shut_down(int command)
{
	int64_t deadline = monotonic_ms() + shutdown_grace_ms;
	sigset_t child;

	fprintf(stderr, "linux-guest-agent: %s\n",
		command == RB_AUTOBOOT ? "rebooting" : "powering off");
	sigemptyset(&child);
	sigaddset(&child, SIGCHLD);
	kill(-1, SIGTERM);
	for (;;) {
		struct timespec timeout;
		int64_t left;
		pid_t pid;

		while ((pid = waitpid(-1, NULL, WNOHANG)) > 0)
			;
		left = deadline - monotonic_ms();
		if ((pid == -1 && errno == ECHILD) || left <= 0)
			break;
		timeout.tv_sec = left / 1000;
		timeout.tv_nsec = left % 1000 * 1000000;
		sigtimedwait(&child, NULL, &timeout);
	}
	kill(-1, SIGKILL);
	while (waitpid(-1, NULL, 0) > 0)
		;
	sync();
	unmount_all();
	sync();
	reboot(command);
	perror("linux-guest-agent: reboot");
	abort();
}

/* Enters /sysroot: switch_root's step, with nothing left that saw the old
 * root, because that ended with the session that asked for it. */
static int switch_root(void)
{
	if (chdir("/sysroot") == -1 ||
	    mount(".", "/", NULL, MS_MOVE, NULL) == -1 || chroot(".") == -1 ||
	    chdir("/") == -1)
		return -1;
	return 0;
}

/* Starts the host's init the way the kernel would: default signal
 * dispositions, nothing blocked, and PID 1's console. It stays in PID 1's
 * session without leading a process group, as the kernel's /init does, so
 * an init that runs setsid(1) does so itself rather than in a forked child,
 * whose parent's exit would power the machine off. Returns an errno value. */
static int start_init(struct command *init)
{
	posix_spawn_file_actions_t actions;
	posix_spawnattr_t attributes;
	sigset_t all;
	int error;

	if ((error = posix_spawn_file_actions_init(&actions)))
		return error;
	if ((error = posix_spawnattr_init(&attributes))) {
		posix_spawn_file_actions_destroy(&actions);
		return error;
	}
	sigfillset(&all);
	if (!(error = posix_spawn_file_actions_addchdir_np(&actions, init->cwd)) &&
	    !(error = posix_spawnattr_setsigdefault(&attributes, &all)) &&
	    !(error = posix_spawnattr_setsigmask(&attributes, &original_mask)) &&
	    !(error = posix_spawnattr_setflags(
		      &attributes, POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)))
		error = spawn_with_path(&init_pid, &actions, &attributes,
					init->argv, init->envp);
	posix_spawn_file_actions_destroy(&actions);
	posix_spawnattr_destroy(&attributes);
	return error;
}

/* Runs after the boot session that asked for it has ended. A failure here
 * cannot be replied to, so PID 1 says why on its console and powers off. */
static void enter_system_root(int init_pipe)
{
	static uint8_t request[4 + max_init_payload];
	struct command init;
	struct cursor cur;
	size_t length = 0;
	uint32_t init_length;
	int error;

	for (;;) {
		ssize_t n = read(init_pipe, request + length,
				 sizeof(request) - length);

		if (n > 0)
			length += n;
		else if (n == 0 || errno != EINTR)
			break;
	}
	if (length < 4 || (init_length = load_u32(request)) != length - 4) {
		fprintf(stderr, "linux-guest-agent: lost the init to start; powering off\n");
		shut_down(RB_POWER_OFF);
	}
	if (switch_root()) {
		fprintf(stderr, "linux-guest-agent: entering /sysroot: %s; powering off\n",
			strerror(errno));
		shut_down(RB_POWER_OFF);
	}
	root_switched = true;
	if (!init_length)
		return;
	cur = (struct cursor){ request + 4, init_length, 0 };
	if (!parse_command(&cur, &init) || cur.offset != init_length)
		error = EINVAL;
	else
		error = start_init(&init);
	if (error) {
		fprintf(stderr, "linux-guest-agent: starting %s: %s; powering off\n",
			init.argv && init.argv[0] ? init.argv[0] : "init",
			strerror(error));
		shut_down(RB_POWER_OFF);
	}
	free_command(&init);
}

static volatile sig_atomic_t power_request;

/* BusyBox init's power signals, which its poweroff, reboot and halt
 * commands send to PID 1. Halt powers off: there is no console to halt on. */
static void power_signal(int signal)
{
	power_request = signal == SIGTERM ? RB_AUTOBOOT : RB_POWER_OFF;
}

static void child_exited(int signal)
{
	(void)signal;
}

/* Collects PID 1's exited children: the session keeper, the init, and
 * orphans the init's processes left. Returns the keeper's status once it
 * has exited, or -1 while it runs. */
static int reap(pid_t keeper)
{
	int keeper_status = -1;

	for (;;) {
		int status;
		pid_t pid = waitpid(-1, &status, WNOHANG);

		if (pid <= 0)
			return keeper_status;
		if (pid == keeper) {
			keeper_status = status;
		} else if (pid == init_pid) {
			fprintf(stderr, "linux-guest-agent: init exited; powering off\n");
			shut_down(RB_POWER_OFF);
		}
	}
}

int main(void)
{
	struct sigaction child_action = { .sa_handler = child_exited };
	struct sigaction power_action = { .sa_handler = power_signal };
	sigset_t handled;
	int session_listener;
	pid_t keeper = 0;
	int init_pipe = -1;

	/* A supervisor pthread would share PID 1's address space. The wasm
	 * kernel refuses to snapshot an address space with another user, so that
	 * would make every later clone of a session keeper fail with EOPNOTSUPP.
	 * Keep PID 1 single-threaded: it blocks the signals it handles and waits
	 * for them only in ppoll, so none can arrive between a check and a
	 * blocking call. PID 1 receives only signals it has a handler for. */
	signal(SIGPIPE, SIG_IGN);
	sigemptyset(&handled);
	sigaddset(&handled, SIGCHLD);
	sigaddset(&handled, SIGTERM);
	sigaddset(&handled, SIGUSR1);
	sigaddset(&handled, SIGUSR2);
	sigprocmask(SIG_BLOCK, &handled, &original_mask);
	sigemptyset(&child_action.sa_mask);
	sigemptyset(&power_action.sa_mask);
	if (sigaction(SIGCHLD, &child_action, NULL) == -1 ||
	    sigaction(SIGTERM, &power_action, NULL) == -1 ||
	    sigaction(SIGUSR1, &power_action, NULL) == -1 ||
	    sigaction(SIGUSR2, &power_action, NULL) == -1) {
		perror("linux-guest-agent: installing signal handlers");
		return 1;
	}
	if (mount_dev()) {
		perror("linux-guest-agent: mounting /dev");
		return 1;
	}
	session_listener = listener(session_port, 1);
	if (session_listener == -1) {
		perror("vsock listener");
		return 1;
	}
	printf("linux-guest-agent: ready on vsock port %d\n", session_port);
	fflush(stdout);
	for (;;) {
		struct pollfd accepting = { .fd = session_listener, .events = POLLIN };
		struct session_worker_args args;
		int status, fd;

		status = reap(keeper);
		if (status != -1) {
			keeper = 0;
			if (WIFSIGNALED(status)) {
				/* Such as a kill(-1, SIGTERM) sent over a lane. */
				fprintf(stderr, "linux-guest-agent: session killed by signal %d\n",
					WTERMSIG(status));
			} else if (WEXITSTATUS(status) == session_exit_switch_root) {
				enter_system_root(init_pipe);
			} else if (WEXITSTATUS(status)) {
				fprintf(stderr, "session worker failed\n");
				return 1;
			}
			close_fd(&init_pipe);
		}
		if (power_request)
			shut_down(power_request);
		/* One session at a time: while the keeper runs, only wait for
		 * signals. */
		if (ppoll(keeper ? NULL : &accepting, keeper ? 0 : 1, NULL,
			  &original_mask) == -1 && errno != EINTR) {
			perror("linux-guest-agent: waiting");
			return 1;
		}
		if (keeper || !(accepting.revents & POLLIN))
			continue;
		fd = accept4(session_listener, NULL, NULL, SOCK_CLOEXEC);
		if (fd == -1) {
			if (errno != EINTR && errno != EAGAIN)
				perror("accept session");
			continue;
		}
		args = (struct session_worker_args){
			.fd = fd,
			.session_listener = session_listener,
		};
		if (pipe2(args.init_pipe, O_CLOEXEC) == -1) {
			perror("linux-guest-agent: creating the init pipe");
			close(fd);
			continue;
		}
		/* The keeper's exit means the session's worker and every one of
		 * its descendants are gone, so the next session starts clean. */
		keeper = clone(session_keeper, keeper_stack + session_stack_size,
			       SIGCHLD, &args);
		close(fd);
		close(args.init_pipe[1]);
		if (keeper == -1) {
			perror("clone session");
			return 1;
		}
		init_pipe = args.init_pipe[0];
	}
}
