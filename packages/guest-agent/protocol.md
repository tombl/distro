# Guest agent protocol, version 3

The guest agent is a dumb syscall executor. It knows nothing about paths,
stat layouts, directories, or flags — every operation-specific decision
lives in the host library (`packages/linux-guest`), which composes injected
syscalls. Process lifecycle (`spawn`/`reap`) is the only domain knowledge
the agent owns, because it is the process's parent and must be.

This file is the frozen contract between `agent.c` and the host library.
Both sides implement it exactly; neither side extends it unilaterally. All
integers are little-endian; there is no alignment padding.

## Transport

Two vsock ports, both handshaking with 8 bytes
`{ magic u32 = 0x584e4c54, version u16 = 3, reserved u16 = 0 }` sent by the
host and echoed verbatim by the agent (the echo doubles as the readiness
signal).

- **Session, port 1024.** One connection, opened first and pinned for the
  session's lifetime. It carries no requests: it exists because a session
  needs a death signal that cannot be stuck behind a blocked syscall. The
  agent parks its main thread reading it; EOF — or any payload byte, which
  means the two sides disagree — triggers teardown: SIGKILL every tracked
  child (this is what unblocks lanes stuck in pipe reads), wait for every
  lane to drain, reap survivors, and return to `accept()` so a fresh host
  can attach during development. fds handed to the host by injected
  `openat` are intentionally leaked on teardown — an abandoned session
  means the machine is going away.
- **Lanes, port 1025.** Up to 64 connections. The host opens them on demand
  and pools them; the agent creates one worker thread as each lane connects.
  A lane carries strictly serial request/reply exchanges: the host writes one
  request and reads its complete reply before reusing the lane. Concurrency is
  the number of lanes in flight; a blocking syscall occupies only its own lane.

Because a lane is serial, there is no framing: no lengths (except spawn's,
below), no request ids, no reply demultiplexing. Every message's size is
computable from what came before it.

## Requests

Each request starts with a kind byte, and every reply starts with the
uniform head `{ ret i64, errno u32 }` — `ret` sign-extended from the
guest's 32-bit long, `errno` nonzero only when `ret` is -1, in which case
nothing follows the head.

**Syscall (kind 1):** `{ nr u32, arg_kinds u8[6], arg_values u64[6] }` then
in-blob bytes in argument order. Arg kinds: 0 scalar (`value` truncated to
the guest's unsigned long), 1 in-blob (`value` is a byte length; the agent
reads that many bytes and passes a pointer), 2 out-blob-full (`value` is a
capacity; a zeroed buffer is passed and the whole buffer follows the reply
head), 3 out-blob-ret-sized (as 2, but only `min(capacity, ret)` bytes
follow — for `read`, `getdents64`, ...). The agent executes via libc
`syscall(nr, a0..a5)`, always six arguments, unused ones scalar 0. 64-bit
arguments on this ILP32 target are split host-side (the syscall table in
`packages/linux-guest/src/syscalls.ts` owns the hi/lo order per syscall).

**Spawn (kind 2):** `{ len u32 }` then a `len`-byte payload
`{ argc u32 } argc × string, string cwd, { envc u32 } envc × string` where
string = `{ len u32, bytes }`, no NUL, len ≤ 4096; argc 1..256, envc ≤ 256,
each env entry contains '='. The length prefix exists so an unparseable
payload is already consumed and can get an `EINVAL` reply without desyncing
the lane. The agent creates three `O_CLOEXEC` pipes, `posix_spawnp`s the
child with the pipe ends on fds 0/1/2 and `addchdir_np(cwd)`, and tracks it
in a fixed table (16 entries; `EAGAIN` when full — the host's process cap
makes this unreachable). Success reply body:
`{ pid u32, stdin_fd u32, stdout_fd u32, stderr_fd u32 }`. From here stdio
is plain injected `read`/`write`/`close` on those fds and signals are plain
injected `kill`.

**Reap (kind 3):** `{ pid u32 }`. Blocking `waitpid`; frees the table
entry; success reply body `{ status u32 }` (raw wait status — the host owns
the WIFEXITED bit math). The host reaps every spawn exactly once, including
on the abort path. Reaping an untracked pid is `ECHILD` from the kernel.

## Validation

The host validates nothing and the agent replies errno (usually `EINVAL`)
to anything well-formed but unacceptable; both ends ship together, so there
is exactly one validator. The agent ends a lane only when the byte stream
itself cannot be trusted: unknown request kind, or a blob/payload length
beyond its cap (128 KiB per blob, 4 MiB for spawn) that it cannot cheaply
skip. The host treats any lane violation — including a short reply — as
fatal to the whole session.

## ABI ownership

`packages/linux-guest/src/abi.ts` is the single schema for every guest ABI
fact the host uses: syscall numbers, `O_*`/`AT_*`/`S_IF*`/`DT_*`/errno/
signal constants, wait-status bit math, and the byte layouts of
`struct stat64` and `struct dirent64` for wasm32-musl. Each entry carries
the C expression it mirrors so `packages/guest-agent/gen-abi-check.ts` can
emit a `_Static_assert` per entry; that file is compiled (never run) with
the guest toolchain, turning any drift into a build failure. Per-syscall
semantics (argument shapes, 64-bit splitting, which argument is the path)
live once each in `packages/linux-guest/src/syscalls.ts`.

## Agent startup

Ignore SIGPIPE, mount `/proc` and `/sys` if absent (the host's `realPath`
and `FsFile.stat` go through `/proc/self/fd/N`), and listen on both ports.
While a session is connected, its main thread polls the silent session
connection and the lane listener, creating a detached worker for each accepted
lane. Session death stops acceptance before teardown waits for those workers.
