// The guest syscall table (protocol v3): what the bytes on a lane mean.
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
//   spawn request:   { kind u8 = 2, len u32 } then { argc u32 } argc x string,
//                    string cwd, { envc u32 } envc x string  (string = u32 len + bytes)
//   reap request:    { kind u8 = 3, pid u32 }
//   reply:           { ret i64, errno u32 } then, when ret != -1: each
//                    out-blob (full: capacity bytes; ret-sized: min(capacity,
//                    ret) bytes), or the spawn/reap reply body.

import { Bytes, FixedArray, I64LE, Struct, U32LE, U64LE, U8 } from "@tombl/linux/bytes";
import { AT, NR, Stat, stat_size, SystemError } from "./abi.ts";
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

class SpawnReply extends Struct({
  pid: U32LE,
  stdin: U32LE,
  stdout: U32LE,
  stderr: U32LE,
}) {}

/** An fd owned by the host in the guest's fd table. Closes exactly once no
 *  matter how many paths race to it (stream EOF, cancel, dispose): a second
 *  close could hit an unrelated file that reused the fd number. Every caller
 *  observes the same result; an error is diagnostic because Linux releases
 *  the fd even when close reports a delayed write failure. */
export class GuestFd implements AsyncDisposable {
  #close?: Promise<void>;

  constructor(
    readonly session: GuestSession,
    readonly fd: number,
    readonly path?: string,
  ) {}

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

async function syscall(
  session: GuestSession,
  nr: number,
  ...args: Arg[]
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

export async function kill(session: GuestSession, pid: number, signal: number): Promise<void> {
  await syscall(session, NR.kill, pid, signal);
}

export async function getpid(session: GuestSession): Promise<number> {
  const { ret } = await syscall(session, NR.getpid);
  return Number(ret);
}

// --- process lifecycle (the agent's only domain knowledge) -----------------

export interface Spawned {
  pid: number;
  stdin: GuestFd;
  stdout: GuestFd;
  stderr: GuestFd;
}

export async function spawn(
  session: GuestSession,
  argv: readonly string[],
  cwd: string,
  env: readonly string[],
): Promise<Spawned> {
  const payload = new Bytes();
  const write_string = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    payload.alloc(U32LE).value = bytes.byteLength;
    payload.append(bytes);
  };
  payload.alloc(U32LE).value = argv.length;
  for (const arg of argv) write_string(arg);
  write_string(cwd);
  payload.alloc(U32LE).value = env.length;
  for (const entry of env) write_string(entry);

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
    const body = new SpawnReply(await lane.read(SpawnReply.size));
    return { body: { pid: body.pid, stdin: body.stdin, stdout: body.stdout, stderr: body.stderr } };
  });
  if (!result.body) throw new SystemError(result.errno);
  return {
    pid: result.body.pid,
    stdin: new GuestFd(session, result.body.stdin, `${argv[0]}:stdin`),
    stdout: new GuestFd(session, result.body.stdout, `${argv[0]}:stdout`),
    stderr: new GuestFd(session, result.body.stderr, `${argv[0]}:stderr`),
  };
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
