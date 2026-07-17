// Guest transport (protocol v3): how bytes travel. What they mean lives in
// syscalls.ts and agent.c.
//
// A session is one pinned vsock connection to the session port plus a pool
// of request lanes. A lane carries strictly serial request/reply exchanges:
// whoever holds it writes one request and reads its reply, so there are no
// frame lengths, request ids, or reply demultiplexing anywhere — message
// sizes are fully determined by the request itself. Concurrency is simply
// the number of lanes in flight.
//
// The session connection carries no requests. It exists because a session
// needs a death signal that cannot be stuck behind a blocked syscall: the
// agent parks a dedicated thread on it, and either side closing it tears the
// session down (agent side: kill and reap every child).

import type { VsockConnection, VsockDevice } from "@tombl/linux";
import { ProtocolError } from "./abi.ts";
import { Bytes, Struct, U16LE, U32LE } from "@tombl/linux/bytes";

const SESSION_PORT = 1024;
const LANE_PORT = 1025;
const HANDSHAKE_MAGIC = 0x584e4c54; // "TLNX"
const PROTOCOL_VERSION = 3;

// Hard cap on concurrent lanes, equal to the agent's worker thread count so
// a lane we open always has a thread free to accept it. The veneer's
// process cap (process.ts) keeps worst-case blocked lanes well under this.
const MAX_LANES = 64;

class Handshake extends Struct({
  magic: U32LE,
  version: U16LE,
  reserved: U16LE,
}) {}

/** One strictly serial request/reply channel. Only ever held by one
 *  exchange at a time; see {@link GuestSession.exchange}. */
export interface Lane {
  write(bytes: Uint8Array): Promise<void>;
  /** Read exactly `length` bytes; a short read means the peer vanished
   *  mid-message, which is a wire violation. */
  read(length: number): Promise<Uint8Array>;
}

class VsockLane implements Lane {
  constructor(readonly conn: VsockConnection) {}

  write(bytes: Uint8Array): Promise<void> {
    return this.conn.write(bytes);
  }

  async read(length: number): Promise<Uint8Array> {
    const bytes = await this.conn.readExactly(length);
    if (bytes.byteLength !== length) {
      throw new ProtocolError("guest connection closed mid-message");
    }
    return bytes;
  }
}

async function handshake(conn: VsockConnection): Promise<void> {
  const bytes = new Bytes(Handshake.size);
  const hello = bytes.alloc(Handshake);
  hello.value = { magic: HANDSHAKE_MAGIC, version: PROTOCOL_VERSION, reserved: 0 };
  await conn.write(bytes.array);
  const echo = await conn.readExactly(Handshake.size);
  if (echo.byteLength !== Handshake.size) {
    throw new ProtocolError("guest connection closed during handshake");
  }
  const reply = new Handshake(echo);
  if (reply.magic !== HANDSHAKE_MAGIC || reply.version !== PROTOCOL_VERSION) {
    throw new ProtocolError("guest handshake echo mismatch");
  }
}

export class GuestSession {
  #device: VsockDevice;
  #session: VsockConnection;
  #dead: Error | null = null;

  #free: VsockLane[] = [];
  #lane_count = 0;
  #waiters: { resolve: (lane: VsockLane) => void; reject: (error: Error) => void }[] = [];

  private constructor(device: VsockDevice, session: VsockConnection) {
    this.#device = device;
    this.#session = session;
    void this.#watch();
  }

  /** One connect + handshake attempt on the session port; the veneer owns
   *  any readiness retry loop. */
  static async connect(
    device: VsockDevice,
    options?: { timeoutMs?: number },
  ): Promise<GuestSession> {
    const conn = await device.connect(
      SESSION_PORT,
      options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
    );
    try {
      await handshake(conn);
    } catch (error) {
      conn.close();
      throw error;
    }
    return new GuestSession(device, conn);
  }

  // The session connection is silent after its handshake: EOF is session
  // death, and any payload byte means the two sides disagree about the
  // protocol.
  async #watch(): Promise<void> {
    try {
      const chunk = await this.#session.read();
      this.#die(
        chunk.byteLength === 0
          ? new Error("guest session closed")
          : new ProtocolError("unexpected data on the session connection"),
      );
    } catch (error) {
      this.#die(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #die(error: Error): void {
    if (this.#dead) return;
    this.#dead = error;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.reject(error);
    for (const lane of this.#free) lane.conn.close();
    this.#free = [];
    this.#session.close();
    // Lanes checked out by in-flight exchanges close when those exchanges
    // fail against their dead connections and release into #dead handling.
  }

  async #acquire(): Promise<VsockLane> {
    if (this.#dead) throw this.#dead;
    const free = this.#free.pop();
    if (free) return free;
    if (this.#lane_count < MAX_LANES) {
      this.#lane_count++;
      try {
        const conn = await this.#device.connect(LANE_PORT);
        const lane = new VsockLane(conn);
        await handshake(conn);
        return lane;
      } catch (error) {
        this.#lane_count--;
        throw error;
      }
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  #release(lane: VsockLane): void {
    if (this.#dead) {
      lane.conn.close();
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve(lane);
    } else {
      this.#free.push(lane);
    }
  }

  /** Run one request/reply exchange on a pooled lane. `fn` must write one
   *  request and read its complete reply. Any exception from `fn` is a wire
   *  violation (semantic errors travel as errno in replies, not exceptions)
   *  and poisons the whole session. */
  async exchange<T>(fn: (lane: Lane) => Promise<T>): Promise<T> {
    const lane = await this.#acquire();
    try {
      const result = await fn(lane);
      this.#release(lane);
      return result;
    } catch (error) {
      this.#die(error instanceof Error ? error : new ProtocolError(String(error)));
      lane.conn.close();
      this.#lane_count--;
      throw error;
    }
  }

  close(): void {
    this.#die(new Error("guest session closed"));
  }
}
