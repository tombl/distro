// The guest syscall table (protocol v6): what the bytes on a lane mean.
//
// Each exported function is one syscall the veneer composes, defined once:
// wire encoding, reply decoding, 64-bit argument splitting, and errno
// conversion all live in the definition, so call sites read like strace
// output. A failed syscall throws SystemError; callers that use an errno
// for control flow catch and inspect it — exceptions are the errno channel,
// there is no second calling style.
//
// Wire shape, both directions fully determined (no framing):
//   syscall request: { kind u8 = 1, nr u32, arg_kinds u8[6], arg_values u64[6] }
//                    then in-blob bytes in argument order
//   spawn request:   { kind u8 = 2, len u32 } then a command, { flags u32 },
//                    { count u32 } and count file actions
//   command:         { argc u32 } argc x string, string cwd, { envc u32 }
//                    envc x string  (string = u32 len + bytes)
//   file action:     { op u32 = 1 (dup2), fd u32, newfd u32 }
//                  | { op u32 = 2 (open), newfd u32, oflag u32, mode u32, string path }
//                  | { op u32 = 3 (close), fd u32 }
//   reap request:    { kind u8 = 3, pid u32 }
//   switch root:     { kind u8 = 5, len u32 } then, when len is nonzero, the
//                    command of the init PID 1 starts in the new root
//   reply:           { ret i64, errno u32 } then, when ret != -1: each
//                    out-blob (full: capacity bytes; ret-sized: min(capacity,
//                    ret) bytes), or the spawn/reap reply body.

import { Bytes, FixedArray, I64LE, Struct, U32LE, U64LE, U8 } from "../bytes/index.ts";
import { AT, NR, OpenHow, Stat, stat_size, SystemError, TIOC, Winsize } from "./abi.ts";
import type { GuestSession } from "./conn.ts";

/** Host convention for bulk I/O: syscall data payloads are at most 32 KiB. */
export const CHUNK = 32 * 1024;

// The agent treats a blob length beyond this as stream corruption (it cannot
// cheaply skip the bytes to stay in sync) and ends the session. CHUNK keeps
// real traffic far below it; this constant exists only to state the contract.
const MAX_BLOB = 128 * 1024;

const REQ_SYSCALL = 1;
const REQ_SPAWN = 2;
const REQ_REAP = 3;
const REQ_SWITCH_ROOT = 5;

const ARG_SCALAR = 0;
const ARG_IN = 1;
const ARG_OUT_FULL = 2;
const ARG_OUT_RET = 3;

class SyscallReq extends Struct({
  kind: U8,
  nr: U32LE,
  arg_kinds: FixedArray(U8, 6),
  arg_values: FixedArray(U64LE, 6),
}) {}

class ReplyHead extends Struct({
  ret: I64LE,
  errno: U32LE,
}) {}

/** An fd owned by the host in the guest's fd table. Closes exactly once no
 *  matter how many paths race to it (stream EOF, cancel, dispose): a second
 *  close could hit an unrelated file that reused the fd number. Every caller
 *  observes the same result; an error is diagnostic because Linux releases
 *  the fd even when close reports a delayed write failure. */
export class GuestFd implements AsyncDisposable {
  #close?: Promise<void>;
  readonly session: GuestSession;
  readonly fd: number;
  readonly path?: string;

  constructor(session: GuestSession, fd: number, path?: string) {
    this.session = session;
    this.fd = fd;
    this.path = path;
  }

  close(): Promise<void> {
    return (this.#close ??= syscall(this.session, NR.close, this.fd).then(() => {}));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

type Arg =
  | number
  | bigint
  | GuestFd // passed as its fd number
  | { in: Uint8Array }
  | { out: number; ret_sized?: boolean };

function syscall(session: GuestSession, nr: number, ...args: Arg[]) {
  return syscall_with(session, nr, args);
}

async function syscall_with(
  session: GuestSession,
  nr: number,
  args: readonly Arg[],
  // Called once the request is written to its lane.
  sent?: () => void,
): Promise<{
  ret: bigint;
  out: Uint8Array[]; // one entry per out arg, in order; empty when ret is -1
}> {
  const request = new Bytes(SyscallReq.size);
  const head = request.alloc(SyscallReq);
  const outs: { capacity: number; ret_sized: boolean }[] = [];

  head.value.kind = REQ_SYSCALL;
  head.value.nr = nr;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (typeof arg === "number" || typeof arg === "bigint") {
      head.value.arg_kinds[i] = ARG_SCALAR;
      head.value.arg_values[i] = BigInt.asUintN(64, BigInt(arg));
    } else if (arg instanceof GuestFd) {
      head.value.arg_kinds[i] = ARG_SCALAR;
      head.value.arg_values[i] = BigInt.asUintN(64, BigInt(arg.fd));
    } else if ("in" in arg) {
      if (arg.in.byteLength > MAX_BLOB) throw new RangeError("in-blob exceeds MAX_BLOB");
      head.value.arg_kinds[i] = ARG_IN;
      head.value.arg_values[i] = BigInt(arg.in.byteLength);
      request.append(arg.in);
    } else {
      if (arg.out > MAX_BLOB) throw new RangeError("out capacity exceeds MAX_BLOB");
      head.value.arg_kinds[i] = arg.ret_sized ? ARG_OUT_RET : ARG_OUT_FULL;
      head.value.arg_values[i] = BigInt(arg.out);
      outs.push({ capacity: arg.out, ret_sized: arg.ret_sized ?? false });
    }
  }

  const { ret, errno, out } = await session.exchange(async (lane) => {
    await lane.write(request.array);
    sent?.();
    const reply = new ReplyHead(await lane.read(ReplyHead.size));
    if (reply.ret === -1n) return { ret: reply.ret, errno: reply.errno, out: [] };
    const out: Uint8Array[] = [];
    for (const spec of outs) {
      const length = spec.ret_sized
        ? Math.min(spec.capacity, Math.max(0, Number(reply.ret)))
        : spec.capacity;
      out.push(await lane.read(length));
    }
    return { ret: reply.ret, errno: reply.errno, out };
  });

  if (ret === -1n) throw new SystemError(errno);
  return { ret, out };
}

// --- the table -------------------------------------------------------------
// Paths are always absolute in this library, so the dirfd of every *at
// syscall is hardcoded to AT_FDCWD.

export async function openat(
  session: GuestSession,
  path: string,
  flags: number,
  mode: number,
): Promise<GuestFd> {
  const { ret } = await syscall(session, NR.openat, AT.FDCWD, c_string(path), flags, mode);
  return new GuestFd(session, Number(ret), path);
}

/** openat2(2): opens `path` relative to `dirfd`, resolved as `how.resolve` says. */
export async function openat2(
  session: GuestSession,
  dirfd: GuestFd,
  path: string,
  how: { flags: number; resolve: number },
): Promise<GuestFd> {
  const bytes = new Bytes(OpenHow.size);
  bytes.alloc(OpenHow).value = {
    flags: BigInt(how.flags),
    mode: 0n,
    resolve: BigInt(how.resolve),
  };
  const { ret } = await syscall(
    session,
    NR.openat2,
    dirfd,
    c_string(path),
    { in: bytes.array },
    OpenHow.size,
  );
  return new GuestFd(session, Number(ret), path);
}

/** mkdirat(2) relative to an open directory rather than the working directory. */
export async function mkdirat_in(dirfd: GuestFd, name: string, mode: number): Promise<void> {
  await syscall(dirfd.session, NR.mkdirat, dirfd, c_string(name), mode);
}

/** Read up to `capacity` bytes; an empty result is EOF. Blocks (holding its
 *  lane) until data is available, so on pipes this can wait indefinitely. */
export async function read(fd: GuestFd, capacity: number): Promise<Uint8Array> {
  const { out } = await syscall(
    fd.session,
    NR.read,
    fd,
    { out: capacity, ret_sized: true },
    capacity,
  );
  return out[0]!;
}

/** Write `data`, returning the (possibly short) count accepted. Blocks
 *  (holding its lane) while the destination pipe or file is full. */
export async function write(fd: GuestFd, data: Uint8Array): Promise<number> {
  const { ret } = await syscall(fd.session, NR.write, fd, { in: data }, data.byteLength);
  return Number(ret);
}

export async function llseek(fd: GuestFd, offset: bigint, whence: number): Promise<bigint> {
  // sys_llseek(fd, offset_high, offset_low, result, whence): the kernel takes
  // the HIGH word first, unlike ftruncate64 below. Asserted by the
  // integration test's seek/truncate round trips.
  const off = BigInt.asUintN(64, offset);
  const { out } = await syscall(
    fd.session,
    NR.llseek,
    fd,
    off >> 32n,
    off & 0xffffffffn,
    { out: 8 },
    whence,
  );
  return I64LE.get(new DataView(out[0]!.buffer, out[0]!.byteOffset), 0);
}

export async function ftruncate64(fd: GuestFd, length: bigint): Promise<void> {
  // ftruncate64(fd, length) splits its loff_t LOW word first, per the musl
  // wasm32 register pairing.
  const len = BigInt.asUintN(64, length);
  await syscall(fd.session, NR.ftruncate64, fd, len & 0xffffffffn, len >> 32n);
}

export async function sync(session: GuestSession): Promise<void> {
  await syscall(session, NR.sync);
}

export async function fsync(fd: GuestFd): Promise<void> {
  await syscall(fd.session, NR.fsync, fd);
}

/** Read one buffer of dirent64 records; an empty result is the end. */
export async function getdents64(fd: GuestFd, capacity: number): Promise<Uint8Array> {
  const { out } = await syscall(
    fd.session,
    NR.getdents64,
    fd,
    { out: capacity, ret_sized: true },
    capacity,
  );
  return out[0]!;
}

export async function fstatat64(
  session: GuestSession,
  path: string,
  flags: number,
): Promise<InstanceType<typeof Stat>> {
  const { out } = await syscall(
    session,
    NR.fstatat64,
    AT.FDCWD,
    c_string(path),
    { out: stat_size },
    flags,
  );
  return new Stat(out[0]!);
}

export async function mkdirat(session: GuestSession, path: string, mode: number): Promise<void> {
  await syscall(session, NR.mkdirat, AT.FDCWD, c_string(path), mode);
}

export async function unlinkat(session: GuestSession, path: string, flags: number): Promise<void> {
  await syscall(session, NR.unlinkat, AT.FDCWD, c_string(path), flags);
}

export async function renameat(session: GuestSession, from: string, to: string): Promise<void> {
  await syscall(session, NR.renameat, AT.FDCWD, c_string(from), AT.FDCWD, c_string(to));
}

export async function symlinkat(
  session: GuestSession,
  target: string,
  path: string,
): Promise<void> {
  await syscall(session, NR.symlinkat, c_string(target), AT.FDCWD, c_string(path));
}

export async function readlinkat(
  session: GuestSession,
  path: string,
  capacity: number,
): Promise<Uint8Array> {
  const { out } = await syscall(
    session,
    NR.readlinkat,
    AT.FDCWD,
    c_string(path),
    { out: capacity, ret_sized: true },
    capacity,
  );
  return out[0]!;
}

export async function fchmodat(session: GuestSession, path: string, mode: number): Promise<void> {
  await syscall(session, NR.fchmodat, AT.FDCWD, c_string(path), mode, 0);
}

export async function fchownat(
  session: GuestSession,
  path: string,
  uid: number,
  gid: number,
): Promise<void> {
  await syscall(session, NR.fchownat, AT.FDCWD, c_string(path), uid, gid, 0);
}

export async function mount(
  session: GuestSession,
  source: string | null,
  target: string,
  type: string | null,
  flags: number,
  data: string | null,
): Promise<void> {
  await syscall(
    session,
    NR.mount,
    nullable_c_string(source),
    c_string(target),
    nullable_c_string(type),
    flags,
    nullable_c_string(data),
  );
}

export async function umount2(session: GuestSession, target: string, flags: number): Promise<void> {
  await syscall(session, NR.umount2, c_string(target), flags);
}

/** Makes a pipe, returning its read and write ends. */
export async function pipe2(session: GuestSession, flags: number): Promise<[GuestFd, GuestFd]> {
  const { out } = await syscall(session, NR.pipe2, { out: 8 }, flags);
  const view = new DataView(out[0]!.buffer, out[0]!.byteOffset);
  return [
    new GuestFd(session, U32LE.get(view, 0), "pipe"),
    new GuestFd(session, U32LE.get(view, 4), "pipe"),
  ];
}

export async function kill(session: GuestSession, pid: number, signal: number): Promise<void> {
  await syscall(session, NR.kill, pid, signal);
}

/**
 * Sends `signal` to PID 1 to power the guest off or reboot it. Resolves
 * `true` once the guest has the request, and `false` if it never got it.
 * PID 1's shutdown may end the session before the reply arrives, which is
 * no failure: the request went out, so the shutdown is under way.
 */
export async function signal_init(session: GuestSession, signal: number): Promise<boolean> {
  let sent = false;
  try {
    await syscall_with(session, NR.kill, [1, signal], () => (sent = true));
    return true;
  } catch (error) {
    if (error instanceof SystemError) return false;
    return sent;
  }
}

/** Resizes a terminal; the kernel sends SIGWINCH to its foreground group. */
export async function set_window_size(fd: GuestFd, rows: number, columns: number): Promise<void> {
  const size = new Bytes(Winsize.size);
  size.alloc(Winsize).value = { ws_row: rows, ws_col: columns, ws_xpixel: 0, ws_ypixel: 0 };
  await syscall(fd.session, NR.ioctl, fd, TIOC.SWINSZ, { in: size.array });
}

/** Unlocks a pseudoterminal's subsidiary so it can be opened: unlockpt(3). */
export async function unlock_terminal(fd: GuestFd): Promise<void> {
  await syscall(fd.session, NR.ioctl, fd, TIOC.SPTLCK, { in: new Uint8Array(4) });
}

/** The number N of a pseudoterminal's subsidiary, `/dev/pts/N`. */
export async function terminal_number(fd: GuestFd): Promise<number> {
  const { out } = await syscall(fd.session, NR.ioctl, fd, TIOC.GPTN, { out: 4 });
  return U32LE.get(new DataView(out[0]!.buffer, out[0]!.byteOffset), 0);
}

/** Hangs up a terminal: blocked reads of it return end of file, and every
 *  later read or write of it fails. */
export async function hang_up(fd: GuestFd): Promise<void> {
  await syscall(fd.session, NR.ioctl, fd, TIOC.VHANGUP);
}

export async function getpid(session: GuestSession): Promise<number> {
  const { ret } = await syscall(session, NR.getpid);
  return Number(ret);
}

const SYSLOG_ACTION_READ_ALL = 3;

/** The last `capacity` bytes of the kernel log, without consuming them. */
export async function read_kernel_log(
  session: GuestSession,
  capacity: number,
): Promise<Uint8Array> {
  const { out } = await syscall(
    session,
    NR.syslog,
    SYSLOG_ACTION_READ_ALL,
    { out: capacity, ret_sized: true },
    capacity,
  );
  return out[0]!;
}

// --- process lifecycle (the agent's only domain knowledge) -----------------

/** A spawn's flags. */
export const SPAWN = {
  /** `POSIX_SPAWN_SETSID`: the process leads a new session. */
  SETSID: 1,
  /** `POSIX_SPAWN_SETSIGDEF` for every signal, so the process does not
   *  inherit the agent's ignored `SIGPIPE`. */
  SETSIGDEF: 2,
} as const;

/** A posix_spawn file action. The process runs them in order, after it
 *  changes to its working directory, on descriptors of the session. */
export type FileAction =
  | { op: "dup2"; fd: GuestFd | number; newfd: number }
  | { op: "open"; path: string; oflag: number; mode?: number; newfd: number }
  | { op: "close"; fd: number };

const FILE_ACTION = { dup2: 1, open: 2, close: 3 } as const;

function write_string(payload: Bytes, value: string) {
  const bytes = new TextEncoder().encode(value);
  payload.alloc(U32LE).value = bytes.byteLength;
  payload.append(bytes);
}

function command_payload(
  payload: Bytes,
  argv: readonly string[],
  cwd: string,
  env: readonly string[],
) {
  payload.alloc(U32LE).value = argv.length;
  for (const arg of argv) write_string(payload, arg);
  write_string(payload, cwd);
  payload.alloc(U32LE).value = env.length;
  for (const entry of env) write_string(payload, entry);
}

/** posix_spawn in the guest: searches the `PATH` in `env` for `argv[0]`,
 *  and returns the pid. The process inherits only the descriptors the file
 *  actions put in place, because every descriptor the host holds is
 *  close-on-exec. */
export async function spawn(
  session: GuestSession,
  argv: readonly string[],
  cwd: string,
  env: readonly string[],
  flags: number,
  actions: readonly FileAction[],
): Promise<number> {
  const payload = new Bytes();
  command_payload(payload, argv, cwd, env);
  payload.alloc(U32LE).value = flags;
  payload.alloc(U32LE).value = actions.length;
  for (const action of actions) {
    payload.alloc(U32LE).value = FILE_ACTION[action.op];
    switch (action.op) {
      case "dup2":
        payload.alloc(U32LE).value = typeof action.fd === "number" ? action.fd : action.fd.fd;
        payload.alloc(U32LE).value = action.newfd;
        break;
      case "open":
        payload.alloc(U32LE).value = action.newfd;
        payload.alloc(U32LE).value = action.oflag;
        payload.alloc(U32LE).value = action.mode ?? 0;
        write_string(payload, action.path);
        break;
      case "close":
        payload.alloc(U32LE).value = action.fd;
        break;
    }
  }

  const request = new Bytes();
  request.alloc(U8).value = REQ_SPAWN;
  request.alloc(U32LE).value = payload.length;
  request.append(payload.array);

  // The errno throw happens outside exchange(): an exception inside it means
  // a wire violation and poisons the session.
  const result = await session.exchange(async (lane) => {
    await lane.write(request.array);
    const reply = new ReplyHead(await lane.read(ReplyHead.size));
    if (reply.ret === -1n) return { errno: reply.errno };
    const body = await lane.read(4);
    return { pid: U32LE.get(new DataView(body.buffer, body.byteOffset), 0) };
  });
  if (result.pid === undefined) throw new SystemError(result.errno);
  return result.pid;
}

/** Asks PID 1 to enter /sysroot once this session ends, then start `init`
 *  there, if given. The session validates /sysroot first, and PID 1 does
 *  the switch only after the host closes the session. */
export async function switch_root(
  session: GuestSession,
  init?: { argv: readonly string[]; cwd: string; env: readonly string[] },
): Promise<void> {
  const payload = new Bytes();
  if (init) command_payload(payload, init.argv, init.cwd, init.env);

  const request = new Bytes();
  request.alloc(U8).value = REQ_SWITCH_ROOT;
  request.alloc(U32LE).value = payload.length;
  request.append(payload.array);

  const errno = await session.exchange(async (lane) => {
    await lane.write(request.array);
    const reply = new ReplyHead(await lane.read(ReplyHead.size));
    return reply.ret === -1n ? reply.errno : 0;
  });
  if (errno) throw new SystemError(errno);
}

/** Blocking waitpid in the guest; returns the raw wait status. Every spawn
 *  must be reaped exactly once or the agent's process table leaks. */
export async function reap(session: GuestSession, pid: number): Promise<number> {
  const request = new Bytes();
  request.alloc(U8).value = REQ_REAP;
  request.alloc(U32LE).value = pid;

  const result = await session.exchange(async (lane) => {
    await lane.write(request.array);
    const reply = new ReplyHead(await lane.read(ReplyHead.size));
    if (reply.ret === -1n) return { errno: reply.errno };
    const body = await lane.read(4);
    return { status: U32LE.get(new DataView(body.buffer, body.byteOffset), 0) };
  });
  if (result.status === undefined) throw new SystemError(result.errno);
  return result.status;
}

// A path argument: UTF-8 bytes plus a trailing NUL, passed as an in-blob.
// The agent rejects nothing here — an embedded NUL simply truncates the path
// the kernel sees, and the resulting ENOENT is a fine answer to a nonsense
// input on a personal system.
function c_string(value: string): { in: Uint8Array } {
  return { in: new TextEncoder().encode(value + "\0") };
}

function nullable_c_string(value: string | null): number | { in: Uint8Array } {
  return value === null ? 0 : c_string(value);
}
