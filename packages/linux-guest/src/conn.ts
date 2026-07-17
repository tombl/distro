// Multiplexed guest-agent protocol client (protocol v2).
//
// One vsock connection to port 1024, established once and multiplexed: a
// single background read loop demuxes replies by id. The agent is a dumb
// syscall executor; this class exposes exactly `syscall`, `spawn`, `reap`
// (plus a blocking-budget semaphore). It reports guest errors as
// `{ret, errno}` and never throws `SystemError`; it throws `ProtocolError`
// only for wire violations, which poison the connection so all in-flight and
// future operations reject.
//
// See packages/guest-agent/protocol.md for the frozen framing.

import type { VsockConnection, VsockDevice } from "@tombl/linux";
import { Bytes, Struct, U16LE, U32LE } from "@tombl/linux/bytes";
import { ProtocolError } from "./errors.ts";

// Inlined from the deleted v1 protocol.ts (its only surviving callers).
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Bytes(length || 1);
  for (const chunk of chunks) output.append(chunk);
  return output.array;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  U32LE.set(new DataView(bytes.buffer), 0, value);
  return bytes;
}

const AGENT_PORT = 1024;
const HANDSHAKE_MAGIC = 0x584e4c54;
const PROTOCOL_VERSION = 2;
const MAX_FRAME_PAYLOAD = 131072; // 128 KiB, payload only

const BLOCKING_PERMITS = 8;
const MAX_SYSCALL_ARGS = 6;
const MAX_STRING_BYTES = 4096;
const MAX_ARGC = 256;
const MAX_ENVC = 256;

const FrameType = {
  Syscall: 1,
  Spawn: 2,
  Reply: 3,
  Reap: 4,
} as const;

const ArgKind = {
  Scalar: 0,
  InBlob: 1,
  OutFull: 2,
  OutRetSized: 3,
} as const;

class FrameHeader extends Struct({
  length: U32LE,
  id: U32LE,
  type: U16LE,
  flags: U16LE,
}) {}

const REPLY_HEADER_SIZE = 16; // { ret i64, errno u32, reserved u32 }
const SYSCALL_FIXED_SIZE = 8 + MAX_SYSCALL_ARGS * 12; // { nr u32, reserved u32 } + 6 args
const SPAWN_REPLY_BODY_SIZE = 16; // { pid u32, stdin u32, stdout u32, stderr u32 }
const REAP_REPLY_BODY_SIZE = 4; // { status u32 }

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

interface Pending {
  decode: (body: Uint8Array) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function guestString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.includes(0)) {
    throw new TypeError("guest strings cannot contain NUL");
  }
  if (bytes.byteLength > MAX_STRING_BYTES) {
    throw new RangeError("guest string is too long");
  }
  return concat([u32(bytes.byteLength), bytes]);
}

export class GuestConn {
  #connection: VsockConnection;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #dead: Error | null = null;

  #permits = BLOCKING_PERMITS;
  #waiters: (() => void)[] = [];

  private constructor(connection: VsockConnection) {
    this.#connection = connection;
    void this.#readLoop();
  }

  // One vsock connect to port 1024 plus the 8-byte handshake and echo verify.
  // Exactly one attempt; the veneer owns any connect-retry loop.
  static async connect(device: VsockDevice, options?: { timeoutMs?: number }): Promise<GuestConn> {
    const connection = await device.connect(
      AGENT_PORT,
      options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
    );
    try {
      const handshake = new Uint8Array(8);
      const dv = view(handshake);
      dv.setUint32(0, HANDSHAKE_MAGIC, true);
      dv.setUint16(4, PROTOCOL_VERSION, true);
      dv.setUint16(6, 0, true); // reserved
      await connection.write(handshake);
      const echo = await connection.readExactly(8);
      if (echo.byteLength !== 8) {
        throw new ProtocolError("guest connection closed during handshake");
      }
      for (let i = 0; i < 8; i++) {
        if (echo[i] !== handshake[i]) {
          throw new ProtocolError("guest handshake echo mismatch");
        }
      }
    } catch (error) {
      connection.close();
      throw error;
    }
    return new GuestConn(connection);
  }

  // --- framing -------------------------------------------------------------

  #die(error: Error): void {
    if (this.#dead) return;
    this.#dead = error;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.reject(error);
    this.#connection.close();
  }

  async #readLoop(): Promise<void> {
    try {
      while (true) {
        const headerBytes = await this.#connection.readExactly(FrameHeader.size);
        if (headerBytes.byteLength === 0) {
          // Clean EOF on a frame boundary: session death, not a wire violation.
          this.#die(new Error("guest connection closed"));
          return;
        }
        if (headerBytes.byteLength !== FrameHeader.size) {
          throw new ProtocolError("guest connection closed mid-frame");
        }
        const header = new FrameHeader(headerBytes);
        if (header.flags !== 0) {
          throw new ProtocolError("unsupported guest frame flags");
        }
        if (header.length > MAX_FRAME_PAYLOAD) {
          throw new ProtocolError("oversized guest frame");
        }
        if (header.type !== FrameType.Reply) {
          throw new ProtocolError("unexpected guest frame type");
        }
        const payload = await this.#connection.readExactly(header.length);
        if (payload.byteLength !== header.length) {
          throw new ProtocolError("guest connection closed mid-frame");
        }
        const pending = this.#pending.get(header.id);
        if (!pending) {
          throw new ProtocolError("reply for unknown request id");
        }
        this.#pending.delete(header.id);
        let result: unknown;
        try {
          result = pending.decode(payload);
        } catch (error) {
          // Malformed reply body: reject this call, then poison the rest.
          const wire = error instanceof Error ? error : new ProtocolError(String(error));
          pending.reject(wire);
          throw wire;
        }
        pending.resolve(result);
      }
    } catch (error) {
      this.#die(error instanceof Error ? error : new ProtocolError(String(error)));
    }
  }

  #send<T>(type: number, payload: Uint8Array, decode: (body: Uint8Array) => T): Promise<T> {
    if (this.#dead) return Promise.reject(this.#dead);
    if (payload.byteLength > MAX_FRAME_PAYLOAD) {
      return Promise.reject(new ProtocolError("oversized guest frame"));
    }
    const id = this.#nextId;
    this.#nextId = (this.#nextId + 1) >>> 0;

    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        decode: decode as (body: Uint8Array) => unknown,
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      const headerBytes = new Uint8Array(FrameHeader.size);
      const header = new FrameHeader(headerBytes);
      header.length = payload.byteLength;
      header.id = id;
      header.type = type;
      header.flags = 0;

      this.#connection.write(concat([headerBytes, payload])).catch((error: unknown) => {
        this.#die(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  // --- operations ----------------------------------------------------------

  syscall(nr: number, ...args: SyscallArg[]): Promise<SyscallResult> {
    if (args.length > MAX_SYSCALL_ARGS) {
      return Promise.reject(new RangeError(`syscall takes at most ${MAX_SYSCALL_ARGS} arguments`));
    }

    const fixed = new Uint8Array(SYSCALL_FIXED_SIZE);
    const dv = view(fixed);
    dv.setUint32(0, nr >>> 0, true);
    dv.setUint32(4, 0, true); // reserved

    const inBlobs: Uint8Array[] = [];
    const outSpecs: { capacity: number; retSized: boolean }[] = [];
    let outTotal = 0;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      const base = 8 + i * 12;
      let kind: number;
      let value: bigint;
      if (typeof arg === "number" || typeof arg === "bigint") {
        kind = ArgKind.Scalar;
        value = BigInt.asUintN(64, BigInt(arg));
      } else if ("in" in arg) {
        kind = ArgKind.InBlob;
        value = BigInt(arg.in.byteLength);
        inBlobs.push(arg.in);
      } else {
        const retSized = arg.retSized ?? false;
        kind = retSized ? ArgKind.OutRetSized : ArgKind.OutFull;
        value = BigInt(arg.out);
        outSpecs.push({ capacity: arg.out, retSized });
        // The agent kills the connection on a reply that cannot fit the
        // frame cap; catch that here as a per-call error instead.
        outTotal += arg.out;
        if (outTotal > MAX_FRAME_PAYLOAD - REPLY_HEADER_SIZE) {
          return Promise.reject(new RangeError("out-blob capacities exceed the reply frame cap"));
        }
      }
      dv.setUint32(base, kind, true);
      dv.setBigUint64(base + 4, value, true);
    }
    // Remaining arg slots default to scalar 0 (already zero-filled).

    const payload = concat([fixed, ...inBlobs]);
    return this.#send(FrameType.Syscall, payload, (body) => decodeSyscall(body, outSpecs));
  }

  spawn(
    argv: readonly string[],
    cwd: string,
    env: readonly string[],
  ): Promise<{
    ret: bigint;
    errno: number;
    pid: number;
    stdin: number;
    stdout: number;
    stderr: number;
  }> {
    if (argv.length < 1 || argv.length > MAX_ARGC) {
      return Promise.reject(new RangeError("argv length out of range"));
    }
    if (env.length > MAX_ENVC) {
      return Promise.reject(new RangeError("too many environment entries"));
    }
    for (const entry of env) {
      if (!entry.includes("=")) {
        return Promise.reject(new TypeError("environment entries must contain '='"));
      }
    }

    let payload: Uint8Array;
    try {
      payload = concat([
        u32(argv.length),
        ...argv.map(guestString),
        guestString(cwd),
        u32(env.length),
        ...env.map(guestString),
      ]);
    } catch (error) {
      return Promise.reject(error as Error);
    }

    return this.#send(FrameType.Spawn, payload, decodeSpawn);
  }

  reap(pid: number): Promise<{ ret: bigint; errno: number; status: number }> {
    return this.#send(FrameType.Reap, u32(pid), decodeReap);
  }

  // --- blocking-budget semaphore (8 permits) -------------------------------

  async blocking<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#permits > 0) {
      this.#permits--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  #release(): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(); // hand the permit straight to the next waiter
    } else {
      this.#permits++;
    }
  }

  close(): void {
    this.#die(new Error("guest connection closed"));
  }
}

// --- reply decoders (throw ProtocolError on any wire violation) ------------

function readReplyHeader(body: Uint8Array): { ret: bigint; errno: number; rest: Uint8Array } {
  if (body.byteLength < REPLY_HEADER_SIZE) {
    throw new ProtocolError("short guest reply");
  }
  const dv = view(body);
  const ret = dv.getBigInt64(0, true); // signed
  const errno = dv.getUint32(8, true);
  // bytes 12..16 reserved
  return { ret, errno, rest: body.subarray(REPLY_HEADER_SIZE) };
}

function decodeSyscall(
  body: Uint8Array,
  outSpecs: { capacity: number; retSized: boolean }[],
): SyscallResult {
  const { ret, errno, rest } = readReplyHeader(body);
  if (ret === -1n) {
    if (rest.byteLength !== 0) {
      throw new ProtocolError("error reply carried a body");
    }
    return { ret, errno, out: [] };
  }
  const out: Uint8Array[] = [];
  let offset = 0;
  for (const spec of outSpecs) {
    const length = spec.retSized ? Math.min(spec.capacity, Number(ret)) : spec.capacity;
    if (offset + length > rest.byteLength) {
      throw new ProtocolError("truncated out-blob in reply");
    }
    out.push(rest.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== rest.byteLength) {
    throw new ProtocolError("trailing bytes in reply");
  }
  return { ret, errno, out };
}

function decodeSpawn(body: Uint8Array): {
  ret: bigint;
  errno: number;
  pid: number;
  stdin: number;
  stdout: number;
  stderr: number;
} {
  const { ret, errno, rest } = readReplyHeader(body);
  if (ret === -1n) {
    if (rest.byteLength !== 0) {
      throw new ProtocolError("error reply carried a body");
    }
    return { ret, errno, pid: 0, stdin: -1, stdout: -1, stderr: -1 };
  }
  if (rest.byteLength !== SPAWN_REPLY_BODY_SIZE) {
    throw new ProtocolError("invalid spawn reply body");
  }
  const dv = view(rest);
  return {
    ret,
    errno,
    pid: dv.getUint32(0, true),
    stdin: dv.getUint32(4, true),
    stdout: dv.getUint32(8, true),
    stderr: dv.getUint32(12, true),
  };
}

function decodeReap(body: Uint8Array): {
  ret: bigint;
  errno: number;
  status: number;
} {
  const { ret, errno, rest } = readReplyHeader(body);
  if (ret === -1n) {
    if (rest.byteLength !== 0) {
      throw new ProtocolError("error reply carried a body");
    }
    return { ret, errno, status: 0 };
  }
  if (rest.byteLength !== REAP_REPLY_BODY_SIZE) {
    throw new ProtocolError("invalid reap reply body");
  }
  return { ret, errno, status: view(rest).getUint32(0, true) };
}
