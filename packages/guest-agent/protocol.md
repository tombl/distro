# Guest agent protocol, version 2

The guest agent is a dumb syscall executor. It knows nothing about paths,
stat layouts, directories, or flags — every operation-specific decision
lives in the host library (`packages/linux-guest`), which composes injected
syscalls. The agent has exactly three operations: `syscall`, `spawn`, and
`reap`. Process lifecycle (`spawn`/`reap`) is the only domain knowledge the
agent owns, because it is the process's parent and must be.

This file is the frozen contract between `agent.c` and the host library.
Both sides implement it exactly; neither side extends it unilaterally.

## Transport and session

- One vsock connection to port 1024, established once per guest session and
  multiplexed. Connection death is session death: the host library rejects
  all in-flight and future operations. There is no reconnect in the host
  library. The agent, after a disconnect, cleans up (below) and returns to
  `accept()` so a fresh host process can attach during development.
- Handshake: host sends 8 bytes `{ magic u32 = 0x584e4c54, version u16 = 2,
  reserved u16 = 0 }`; agent replies with the identical 8 bytes. A
  successful handshake replaces the v1 ping loop as the readiness signal.
- All integers little-endian. No alignment padding beyond what is stated.

## Framing

Every message after the handshake, both directions:

    { length u32, id u32, type u16, flags u16 } then `length` payload bytes

- `length` counts payload only. Max payload: 131072 (128 KiB).
- `id` is assigned by the host; replies echo it. The host may pipeline
  requests; replies may arrive in any order.
- `flags` must be 0.
- Types: 1 = syscall request, 2 = spawn request, 3 = reply, 4 = reap
  request. A malformed frame (bad type, bad length, nonzero flags,
  truncated payload) means the agent closes the connection. There are no
  protocol-level error frames; errors travel as errno in replies.

## Reply (type 3, agent → host)

Uniform for all three request kinds:

    { ret i64, errno u32, reserved u32 } then a request-specific body

- `ret` is the syscall return value sign-extended from the guest's 32-bit
  long (spawn/reap use 0 for success, -1 for failure).
- `errno` is nonzero only when `ret` is -1, in which case the body is empty.

## Syscall request (type 1)

    { nr u32, reserved u32 } then 6 × { kind u32, value u64 }
    then in-blob bytes concatenated in argument order

Argument kinds:

- 0 scalar: `value` truncated to the guest's unsigned long and passed
  directly.
- 1 in-blob: `value` is the blob's byte length; the agent allocates,
  copies the next `value` bytes from the request tail, and passes the
  pointer.
- 2 out-blob (full): `value` is a capacity; the agent passes a
  zero-initialized buffer of that size and returns the entire buffer in
  the reply body (used for `fstatat`, `_llseek`'s result pointer, …).
- 3 out-blob (ret-sized): as kind 2, but the reply carries only
  `min(capacity, ret)` bytes (used for `read`, `getdents64`,
  `readlinkat`, …). Only meaningful when `ret` is a byte count.

Reply body: out-blob contents concatenated in argument order (empty when
`ret` is -1). The agent executes via libc `syscall(nr, a0..a5)` — always
six arguments, unused ones zero. Blobs must fit the frame cap; the host
convention for bulk I/O is 32 KiB chunks. Syscalls with 64-bit arguments
on this ILP32 target (e.g. `_llseek`, `ftruncate64`) are composed
host-side per the musl wasm32 ABI; the agent never splits or pairs
registers itself.

## Spawn request (type 2)

    { argc u32 } argc × string, string cwd, { envc u32 } envc × string

where string = `{ len u32, bytes }`, no NUL, len ≤ 4096. Limits: argc ≤
256 and ≥ 1, envc ≤ 256, each env entry contains '='.

The agent creates three `O_CLOEXEC` pipes, `posix_spawnp`s the child with
the pipe ends dup2'd to fds 0/1/2 and `addchdir_np(cwd)`, and tracks the
child in a fixed table (16 entries; `EAGAIN` when full — the host's
blocking-budget makes this unreachable in practice).

Reply body on success: `{ pid u32, stdin_fd u32, stdout_fd u32,
stderr_fd u32 }` — the agent-side pipe fds. From here the host drives
stdio with plain injected `read`/`write`/`close` on those fds. Signals are
plain injected `kill`. There is no attach rendezvous, no stream
connections, no start message.

## Reap request (type 4)

    { pid u32 }

The agent does a blocking `waitpid(pid, &status, 0)`, frees the table
entry, and replies with body `{ status u32 }` (raw wait status; the host
decodes WIFEXITED/WEXITSTATUS/WTERMSIG bit math). The host reaps every
spawn exactly once — `ChildProcess.status` always runs, including on the
abort path (kill then reap). Reaping an untracked pid is `ECHILD` from the
kernel; the agent adds nothing.

## Disconnect cleanup (agent)

On connection death: SIGKILL every tracked, unreaped pid; `waitpid` each
best-effort; reset the table; return to `accept()`. fds handed to the host
by injected `openat` are intentionally leaked — an abandoned session means
the machine is being torn down; the reconnect path exists only for
development convenience.

## Concurrency

- Agent: the accept/read loop is the only reader; it pushes requests into
  a bounded ring (32 entries, blocks when full — vsock provides
  backpressure); 12 detached workers execute requests; replies are
  serialized by one write mutex. No live-slot accounting: no request holds
  a worker beyond its own syscall.
- Host: a blocking injected syscall occupies an agent worker for its
  duration. The host library holds a semaphore of 8 permits for
  blocking-class operations — process stream reads, stdin writes, and
  reaps — leaving ≥4 workers always free for fast syscalls (notably
  `kill`, which is how a blocked stream read gets unblocked: kill the
  process, the pipe EOFs). Filesystem syscalls on regular files do not
  take permits.

## ABI ownership

`packages/linux-guest/src/abi.ts` is the single, explicit schema for every
guest ABI fact the host uses: syscall numbers (asm-generic, e.g.
`__NR_openat` = 56), `O_*`/`AT_*`/`S_IF*`/`SEEK_*`/signal/wait constants,
and the byte layouts of `struct stat` and `struct dirent64` for
wasm32-musl, derived from `checkouts/musl` and
`checkouts/linux/include/uapi`. Each entry carries the C expression it
mirrors so that `packages/guest-agent/gen-abi-check.ts` can emit a
`_Static_assert` per entry; that file is compiled (never run) with the
guest toolchain in the guest-agent build, turning any drift into a build
failure. No generated code is checked in.

## Host library interface (conn.ts)

The layer the filesystem/exec veneer builds on, pinned so both can be
written concurrently:

```ts
export type SyscallArg =
  | number
  | bigint // scalar
  | { in: Uint8Array } // in-blob
  | { out: number; retSized?: boolean }; // out-blob capacity

export interface SyscallResult {
  ret: bigint;
  errno: number;
  out: Uint8Array[]; // one entry per out-blob arg, in order; empty on ret -1
}

export class GuestConn {
  // retries vsock connect+handshake internally is NOT done here; one attempt.
  static connect(
    device: VsockDevice,
    options?: { timeoutMs?: number },
  ): Promise<GuestConn>;
  syscall(nr: number, ...args: SyscallArg[]): Promise<SyscallResult>;
  // runs fn while holding one of the 8 blocking permits
  blocking<T>(fn: () => Promise<T>): Promise<T>;
  spawn(
    argv: readonly string[],
    cwd: string,
    env: readonly string[],
  ): Promise<
    { ret: bigint; errno: number; pid: number; stdin: number; stdout: number; stderr: number }
  >;
  reap(pid: number): Promise<{ ret: bigint; errno: number; status: number }>;
  close(): void;
}
```

`syscall`/`spawn`/`reap` never throw `SystemError` — they report
`{ret, errno}` and the veneer converts, attaching the syscall name and
paths exactly as `errors.ts` does today. `GuestConn` throws
`ProtocolError` only for wire violations, and rejects everything when the
connection dies.

Veneer conventions (informative): `createGuestClient(vsock)` stays
synchronous and connects lazily on first use (memoized); readiness in
`spawnGuest` is a connect-retry loop (25 ms interval, 30 s deadline)
replacing the v1 ping loop; `realpath` is `openat(O_PATH)` +
`readlinkat("/proc/self/fd/N")`; `readDir` is `openat(O_DIRECTORY)` +
`getdents64` loops; recursive mkdir/remove and `copyFile` are TS
compositions of the primitives. The public API in `index.ts` and the
integration test are frozen.

## Agent startup (unchanged from v1)

Ignore SIGPIPE, mount `/proc` and `/sys` if absent (realpath's
`/proc/self/fd` trick depends on this), listen on vsock port 1024.
