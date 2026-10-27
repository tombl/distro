# Guest agent protocol, version 6

The guest agent is a dumb syscall executor. It knows nothing about paths,
stat layouts, directories, or flags — every operation-specific decision
lives in the host library (`packages/linux-guest`), which composes injected
syscalls. Process lifecycle (`spawn`/`reap`) is the only domain knowledge
the agent owns, because it is the process's parent and must be, and as
PID 1 it enters the root the host prepared (`switch_root`). It knows no
filesystems: the host mounts everything with ordinary syscalls. It makes no
descriptors for a process either: the host makes pipes and terminals with
ordinary syscalls and names them in the spawn's file actions.

This file is the frozen contract between `agent.c` and the host library.
Both sides implement it exactly; neither side extends it unilaterally. All
integers are little-endian; there is no alignment padding.

## Transport

Two vsock ports, both handshaking with 8 bytes
`{ magic u32 = 0x584e4c54, version u16 = 6, reserved u16 = 0 }` sent by the
host and echoed verbatim by the agent (the echo doubles as the readiness
signal).

- **Session, port 1024.** One connection, opened first and pinned for the
  session's lifetime. It carries no requests: it exists because a session
  needs a death signal that cannot be stuck behind a blocked syscall. The
  agent parks the session process reading it; EOF — or any payload byte,
  which means the two sides disagree — exits that process, atomically closing
  every lane and session-owned fd. Its parent, the session's keeper, then
  SIGKILLs and reaps every remaining descendant before PID 1 returns to
  `accept()`, so a fresh host can attach during development without
  inheriting resources from the abandoned session.
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

**Spawn (kind 2):** `posix_spawn`, serialized. `{ len u32 }` then a
`len`-byte payload: a command, `{ flags u32 }`, `{ count u32 }`, and `count`
file actions.

- A *command* is `{ argc u32 } argc × string, string cwd, { envc u32 } envc ×
  string`, where string = `{ len u32, bytes }`, no NUL, len ≤ 4096; argc
  1..256, envc ≤ 256, each env entry contains '='.
- *Flags*: 1 is `POSIX_SPAWN_SETSID`, so the process leads a new session; 2
  is `POSIX_SPAWN_SETSIGDEF` for every signal, so it does not inherit the
  agent's ignored `SIGPIPE`. Other bits are `EINVAL`.
- *File actions*, at most 64, each `{ op u32 }` and its operands:
  - op 1, `dup2`: `{ fd u32, newfd u32 }`;
  - op 2, `open`: `{ newfd u32, oflag u32, mode u32, string path }`;
  - op 3, `close`: `{ fd u32 }`.

The process changes to `cwd`, then runs the file actions in order, so a
relative `open` path names what a shell redirection would. Descriptors are
numbers in the session process's table. Every descriptor the host holds there
is close-on-exec, and `dup2` clears that flag on `newfd`, so the process
inherits exactly what its file actions put in place. The agent searches the
supplied `PATH` for an `argv[0]` without a slash by trying `posix_spawn` with
each entry, and the file actions run again in each attempt's child, so they
should not depend on running once (an `open` with `O_EXCL`, say). A `dup2`
or `close` of a negative descriptor, and a bad descriptor or path at run time,
fail the spawn with the errno `posix_spawn` reports, which is indistinguishable
from the `exec`'s own: an `open` that fails with `ENOENT` reads as a missing
program. The agent tracks the process in a fixed table (16 entries; `EAGAIN`
when full — the host's process cap makes this unreachable). Success reply
body: `{ pid u32 }`. From here stdio is plain injected `read`/`write`/`close`
on the host's descriptors, and signals are plain injected `kill`.

The host makes what the actions name:

- a pipe with `pipe2(O_CLOEXEC)`, passing the process's end by `dup2` and
  closing it once the spawn returns;
- a terminal with `openat("/dev/ptmx", O_RDWR | O_NOCTTY | O_CLOEXEC)`,
  `ioctl(TIOCSPTLCK)` to unlock it, `ioctl(TIOCGPTN)` for its number `N`,
  and `ioctl(TIOCSWINSZ)` to size it. The process spawns with `setsid` and
  opens `/dev/pts/N` on fd 0, then duplicates it onto 1 and 2: a session
  leader that opens a terminal without `O_NOCTTY` gets it as its controlling
  terminal. The host resizes with `TIOCSWINSZ` on the master, and once the
  master reads `EIO` every holder of the subsidiary has closed it;
- `/dev/null` with an `open` action, and a file it already holds open with
  `dup2`.

**Reap (kind 3):** `{ pid u32 }`. Blocking `waitpid`; frees the table
entry; success reply body `{ status u32 }` (raw wait status — the host owns
the WIFEXITED bit math). The host reaps every spawn exactly once, including
on the abort path. Reaping an untracked pid is `ECHILD` from the kernel.

**Switch root (kind 5):** `{ len u32 }` then, when `len` is nonzero, a
command (as in kind 2, `len` ≤ 32 KiB) naming the init that PID 1 starts in
the new root. The session validates first and replies an errno on
failure: `/sysroot` must be a directory on a different filesystem from `/`
(`EINVAL`), `/sysroot/dev`, `/sysroot/proc`, and `/sysroot/sys` must exist
and be mount points (`ENOENT`, `EINVAL`), an unparseable init is `EINVAL`,
and a second request in the session or any request after PID 1 has switched
root is `EBUSY`. On success the reply has no body, and the switch happens
only once the host ends the session: PID 1 then runs `chdir("/sysroot")`,
`mount(".", "/", NULL, MS_MOVE)`, `chroot(".")` and `chdir("/")`, starts the
init if one was given, and accepts the next session, which sees the new
root. Nothing that saw the old root survives, because the session's keeper
ends every process the session started. If the switch or the init's start
fails anyway, PID 1 cannot reply: it says why on its console and powers
off.

## Validation

The host validates nothing and the agent replies errno (usually `EINVAL`)
to anything well-formed but unacceptable; both ends ship together, so there
is exactly one validator. The agent ends a lane only when the byte stream
itself cannot be trusted: unknown request kind, or a blob/payload length
beyond its cap (128 KiB per blob, 4 MiB for spawn, 32 KiB for switch root)
that it cannot cheaply
skip. The host treats any lane violation — including a short reply — as
fatal to the whole session.

## ABI ownership

`packages/linux-guest/src/abi.ts` is the single schema for every guest ABI
fact the host uses: syscall numbers, `O_*`/`AT_*`/`S_IF*`/`DT_*`/errno/
signal constants, wait-status bit math, and the byte layouts of
`struct stat64` and `struct dirent64` for wasm32-musl. Each entry carries
the C expression it mirrors so `distro/guest-agent/gen-abi-check.ts` can
emit a `_Static_assert` per entry; that file is compiled (never run) with
the guest toolchain, turning any drift into a build failure. Per-syscall
semantics (argument shapes, 64-bit splitting, which argument is the path)
live once each in `packages/linux-guest/src/syscalls.ts`.

## PID 1

The kernel runs the agent as `/init` from its initramfs, a newc archive
holding only that file. PID 1 ignores SIGPIPE, mounts devtmpfs on `/dev`,
holds fds 0–2 open on `/dev/null` when the kernel gave it no console, and
listens on the session port. That is all the C does at boot: the host mounts
`/proc`, `/sys`, and everything else, and keeps `/proc` mounted for its
`realPath` and `FsFile.stat`, which go through `/proc/self/fd/N`.

PID 1 serves one session at a time. Each accepted session runs in a child
subreaper which owns the lane listener, lane threads, spawned children, and
every injected fd. While a session is connected, that process polls the silent
session connection and lane listener, creating a detached worker for each
accepted lane. Session death exits the entire process, so blocked lane threads
cannot delay teardown. That process's parent is a per-session keeper, itself a
subreaper, which inherits every surviving descendant whatever process group or
session it moved to. The keeper SIGKILLs them until none remain, and PID 1
accepts the next session once the keeper exits. Until PID 1 supervises an
init, every process but PID 1 and the keeper belongs to the session, so the
keeper kills with `kill(-1)`; with an init, it finds its own adopted children
through `/proc`. A session killed by a signal is not PID 1's failure.

PID 1 starts the init named by a switch root request as the kernel starts
`/init`: default signal dispositions, an empty signal mask, PID 1's console as
its standard descriptors, and PID 1's session, without leading a process
group, so an init that runs `setsid` keeps its pid. PID 1 reaps it and any
orphans it leaves. The init's exit powers the machine off. So do SIGUSR2 and SIGUSR1
(BusyBox `poweroff` and `halt`), and SIGTERM (`reboot`) reboots. Each runs
BusyBox init's shutdown sequence: SIGTERM to every process, up to 3 s for
them to exit, SIGKILL, `sync`, unmount every mount in reverse
`/proc/self/mounts` order (remounting read-only whatever stays busy, and
always `/`), then `reboot(2)`. PID 1 stays single-threaded: it blocks the
signals it handles and waits for them only inside `ppoll`, so none arrive
between a check and a blocking call.
