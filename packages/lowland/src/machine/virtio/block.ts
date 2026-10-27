// SPDX-License-Identifier: MIT

import { Struct, U32LE, U64LE } from "../../bytes/index.ts";
import { assert } from "../util.ts";
import { type Device, public_handle, VirtioDevice } from "./device.ts";
import type { Virtqueue, VirtqueueChain } from "./queue.ts";

const BlockDeviceFeatures = {
  SEG_MAX: 1n << 2n,
  RO: 1n << 5n,
  FLUSH: 1n << 9n,
} as const;

// The most data segments the guest may put in one request. Indirect
// descriptors let a request carry more than the ring holds.
const SEG_MAX = 128;

class BlockDeviceConfig extends Struct({ capacity: U64LE, size_max: U32LE, seg_max: U32LE }) {}

class BlockDeviceRequest extends Struct({
  type: U32LE,
  reserved: U32LE,
  sector: U64LE,
}) {}

const BlockDeviceRequestType = {
  IN: 0,
  OUT: 1,
  FLUSH: 4,
  GET_ID: 8,
} as const;

const BlockDeviceStatus = {
  OK: 0,
  IOERR: 1,
  UNSUPP: 2,
} as const;

// The device ID is NUL-padded ASCII, unterminated when it fills all 20 bytes.
const ID_BYTES = 20;

type MaybePromise<T> = T | Promise<T>;

/**
 * The storage behind a block device.
 *
 * The arrays passed to storage are the guest's own memory. Use them only
 * until the returned promise settles: a guest reset waits for that, then
 * reuses the memory.
 */
export interface BlockStorage {
  /** Reads into `target` at `offset`, returning the bytes read. */
  read(offset: number, target: Uint8Array): MaybePromise<number>;
  /** Writes `data` at `offset`, returning the bytes written. Without it the device is read-only. */
  write?(offset: number, data: Uint8Array): MaybePromise<number>;
  /**
   * Reads consecutive bytes at `offset` into each of `targets` in turn,
   * returning the bytes read. Optional: without it, a request split across
   * guest memory takes one `read()` per contiguous piece.
   */
  readv?(offset: number, targets: readonly Uint8Array[]): MaybePromise<number>;
  /** Writes each of `sources` in turn at `offset`, returning the bytes written. Optional, like `readv`. */
  writev?(offset: number, sources: readonly Uint8Array[]): MaybePromise<number>;
  /**
   * Flushes completed writes. Its presence advertises the flush feature.
   * Requests may be in flight concurrently, but a flush is only issued once
   * every write requested before it has completed.
   */
  flush?(): MaybePromise<void>;
  /** Releases storage resources when the device closes. */
  close?(): MaybePromise<void>;
  /** Total size in bytes. */
  capacity: number;
}

/** Options for {@link blockDevice}. */
export interface BlockDeviceOptions {
  /**
   * The disk's serial number, which the guest reads from
   * `/sys/block/vdX/serial`. It identifies the disk regardless of the order
   * the guest discovered its devices in. At most 20 printable ASCII
   * characters. Defaults to empty.
   */
  serial?: string;
}

function encode_serial(serial: string) {
  assert(
    /^[\x20-\x7e]*$/.test(serial) && serial.length <= ID_BYTES,
    "block device serial must be at most 20 printable ASCII characters",
  );
  const id = new Uint8Array(ID_BYTES);
  id.set(new TextEncoder().encode(serial));
  return id;
}

/** Merges segments that are adjacent in memory into single views. */
function runs(segments: readonly Uint8Array[]) {
  const merged: Uint8Array[] = [];
  for (const segment of segments) {
    if (segment.byteLength === 0) continue;
    const last = merged.at(-1);
    if (
      last &&
      last.buffer === segment.buffer &&
      last.byteOffset + last.byteLength === segment.byteOffset
    ) {
      merged[merged.length - 1] = new Uint8Array(
        last.buffer,
        last.byteOffset,
        last.byteLength + segment.byteLength,
      );
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

/**
 * Moves a request's segments with as few storage calls as possible: one call
 * for one contiguous run or a vectored call, otherwise one call per run.
 * Returns the bytes moved, stopping at the first short call.
 */
async function transfer(
  offset: number,
  segments: readonly Uint8Array[],
  single: (offset: number, array: Uint8Array) => MaybePromise<number>,
  vectored: ((offset: number, arrays: readonly Uint8Array[]) => MaybePromise<number>) | undefined,
) {
  const pieces = runs(segments);
  if (pieces.length === 1) return single(offset, pieces[0]!);
  if (vectored) return vectored(offset, pieces);
  let moved = 0;
  for (const piece of pieces) {
    const n = await single(offset + moved, piece);
    moved += n;
    if (n !== piece.byteLength) break;
  }
  return moved;
}

class BlockDevice extends VirtioDevice {
  readonly #storage: BlockStorage;
  /** Writes in flight, which a flush must wait for. */
  readonly #writes = new Set<Promise<number>>();
  /** The advertised capacity in bytes: whole sectors only. */
  readonly #capacity: bigint;
  readonly #id: Uint8Array;

  constructor(storage: BlockStorage, options: BlockDeviceOptions) {
    const config = new Uint8Array(BlockDeviceConfig.size);
    const fields = new BlockDeviceConfig(config);
    const sectors = BigInt(Math.floor(storage.capacity / 512));
    fields.capacity = sectors;
    fields.seg_max = SEG_MAX;
    let features = BlockDeviceFeatures.SEG_MAX;
    if (storage.flush) features |= BlockDeviceFeatures.FLUSH;
    if (!storage.write) features |= BlockDeviceFeatures.RO;
    // Storage works on guest memory directly; a guest reset waits for it.
    super({ id: 2, queues: 1, features, config, views: true });
    this.#storage = storage;
    this.#capacity = sectors * 512n;
    this.#id = encode_serial(options.serial ?? "");
  }

  protected kick(_vq: number, queue: Virtqueue) {
    // Requests are independent: start each one now and let them complete in
    // any order, rather than holding later chains behind slow storage.
    for (const chain of queue) this.spawn(this.#request(chain));
  }

  async #request(chain: VirtqueueChain) {
    const storage = this.#storage;
    const descs = [...chain];
    const header = descs[0];
    const status = descs[descs.length - 1];
    const data = descs.slice(1, -1);
    const segments = data.map((desc) => desc.array);

    assert(header && !header.writable, "header must be readonly");
    assert(
      header.array.byteLength === BlockDeviceRequest.size,
      `header size is ${header.array.byteLength}`,
    );
    assert(status && status.writable, "status must be writable");
    assert(status.array.byteLength === 1, `status size is ${status.array.byteLength}`);

    // The header is guest memory: read it before anything can await.
    const request = new BlockDeviceRequest(header.array.slice());
    const length = segments.reduce((total, array) => total + array.byteLength, 0);
    // Storage sees only the advertised sectors, in at most SEG_MAX segments.
    // Checked in bigint, so the offset below is exact.
    const start = request.sector * 512n;
    const valid = data.length <= SEG_MAX && start + BigInt(length) <= this.#capacity;
    const offset = Number(start);
    let result: number = BlockDeviceStatus.OK;
    // Bytes of the writable payload initialized from its start.
    let filled = 0;
    switch (request.type) {
      case BlockDeviceRequestType.IN: {
        assert(
          data.every((desc) => desc.writable),
          "data must be writable when IN",
        );
        if (!valid) {
          result = BlockDeviceStatus.IOERR;
          break;
        }
        if (length === 0) break;
        const read = await transfer(
          offset,
          segments,
          (at, target) => storage.read(at, target),
          storage.readv && ((at, targets) => storage.readv!(at, targets)),
        );
        filled = Math.min(read, length);
        if (read !== length) result = BlockDeviceStatus.IOERR;
        break;
      }
      case BlockDeviceRequestType.OUT: {
        assert(
          data.every((desc) => !desc.writable),
          "data must be readonly when OUT",
        );
        const write = storage.write;
        if (!write) {
          result = BlockDeviceStatus.UNSUPP;
          break;
        }
        if (!valid) {
          result = BlockDeviceStatus.IOERR;
          break;
        }
        if (length === 0) break;
        // Registered before awaiting, so a flush queued after this request
        // waits for it.
        const written = transfer(
          offset,
          segments,
          (at, source) => write.call(storage, at, source),
          storage.writev && ((at, sources) => storage.writev!(at, sources)),
        );
        this.#writes.add(written);
        try {
          if ((await written) !== length) result = BlockDeviceStatus.IOERR;
        } finally {
          this.#writes.delete(written);
        }
        break;
      }
      case BlockDeviceRequestType.FLUSH: {
        if (!storage.flush) {
          result = BlockDeviceStatus.UNSUPP;
          break;
        }
        await Promise.allSettled(this.#writes);
        await storage.flush();
        break;
      }
      case BlockDeviceRequestType.GET_ID: {
        assert(
          data.every((desc) => desc.writable),
          "data must be writable when GET_ID",
        );
        // The guest's buffer is not zeroed, so write the padding too.
        let n = 0;
        for (const segment of segments) {
          const piece = this.#id.subarray(n, n + segment.byteLength);
          segment.set(piece);
          n += piece.byteLength;
        }
        filled = n;
        break;
      }
      default:
        console.error("unknown request type", request.type);
        result = BlockDeviceStatus.UNSUPP;
    }

    // The used length covers every writable buffer through the status byte
    // that ends them, so a driver can rely on the status. Each byte it
    // covers must be initialized, so the payload past what the request
    // filled is zeroed: a short or rejected read, padding past the ID, or an
    // unsupported request's writable buffers.
    let offset_in_payload = 0;
    let written = 1;
    for (const desc of data) {
      if (!desc.writable) continue;
      const segment = desc.array;
      const start = Math.max(0, filled - offset_in_payload);
      if (start < segment.byteLength) segment.fill(0, start);
      offset_in_payload += segment.byteLength;
      written += segment.byteLength;
    }
    status.array[0] = result;
    chain.release(written);
  }

  protected close() {
    return this.#storage.close?.();
  }
}

/**
 * A virtio block device backed by a storage object.
 *
 * @example Serve a read-only root filesystem image
 * ```ts
 * blockDevice(
 *   {
 *     capacity: rootfs.byteLength,
 *     read(offset, target) {
 *       const source = rootfs.subarray(offset, offset + target.byteLength);
 *       target.set(source);
 *       return source.byteLength;
 *     },
 *   },
 *   { serial: "root" },
 * )
 * ```
 */
export function blockDevice(storage: BlockStorage, options: BlockDeviceOptions = {}): Device {
  // Byte offsets up to the capacity must be exact JavaScript numbers.
  assert(
    storage.capacity >= 0 && storage.capacity <= Number.MAX_SAFE_INTEGER,
    "block storage capacity must be a safe integer number of bytes",
  );
  return public_handle(new BlockDevice(storage, options), {});
}
