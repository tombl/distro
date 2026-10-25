// SPDX-License-Identifier: MIT

import { Struct, U32LE, U64LE } from "@lowland/bytes";
import { assert } from "../util.ts";
import { type Device, public_handle, VirtioDevice } from "./device.ts";
import type { Virtqueue, VirtqueueChain } from "./queue.ts";

const BlockDeviceFeatures = {
  RO: 1n << 5n,
  FLUSH: 1n << 9n,
} as const;

class BlockDeviceConfig extends Struct({ capacity: U64LE }) {}

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

type MaybePromise<T> = T | Promise<T>;

/** The storage behind a block device. */
export interface BlockStorage {
  /** Reads into `target` at `offset`, returning the bytes read. */
  read(offset: number, target: Uint8Array): MaybePromise<number>;
  /**
   * Writes `data` at `offset`, returning the bytes written. Without it the
   * device is read-only. Do not keep `data` after the returned promise
   * settles: it may be reused.
   */
  write?(offset: number, data: Uint8Array): MaybePromise<number>;
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

/** @deprecated Renamed to `BlockStorage`. */
export type BlockDeviceStorage = BlockStorage;

/**
 * Joins a request's data into one array: a view when it is one contiguous
 * run of memory, otherwise a copy.
 */
function gather(arrays: readonly Uint8Array[], length: number) {
  const [first] = arrays;
  assert(first);
  let end = first.byteOffset + first.byteLength;
  for (const array of arrays.slice(1)) {
    if (array.buffer !== first.buffer || array.byteOffset !== end) {
      const joined = new Uint8Array(length);
      let offset = 0;
      for (const part of arrays) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      return joined;
    }
    end += array.byteLength;
  }
  return new Uint8Array(first.buffer, first.byteOffset, length);
}

function scatter(source: Uint8Array, targets: readonly Uint8Array[]) {
  let offset = 0;
  for (const target of targets) {
    target.set(source.subarray(offset, offset + target.byteLength));
    offset += target.byteLength;
  }
}

class BlockDevice extends VirtioDevice {
  readonly #storage: BlockStorage;
  /** Writes in flight, which a flush must wait for. */
  readonly #writes = new Set<Promise<number>>();

  constructor(storage: BlockStorage) {
    const config = new Uint8Array(BlockDeviceConfig.size);
    new BlockDeviceConfig(config).capacity = BigInt(storage.capacity / 512);
    let features = 0n;
    if (storage.flush) features |= BlockDeviceFeatures.FLUSH;
    if (!storage.write) features |= BlockDeviceFeatures.RO;
    super({ id: 2, queues: 1, features, config });
    this.#storage = storage;
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
    const data = descs.slice(1, -1).map((desc) => desc.array);

    assert(header && !header.writable, "header must be readonly");
    assert(
      header.array.byteLength === BlockDeviceRequest.size,
      `header size is ${header.array.byteLength}`,
    );
    assert(status && status.writable, "status must be writable");
    assert(status.array.byteLength === 1, `status size is ${status.array.byteLength}`);

    const request = new BlockDeviceRequest(header.array);
    const offset = Number(request.sector) * 512;
    const length = data.reduce((total, array) => total + array.byteLength, 0);
    let result: number = BlockDeviceStatus.OK;
    let n = 0;
    switch (request.type) {
      case BlockDeviceRequestType.IN: {
        assert(
          descs.slice(1, -1).every((desc) => desc.writable),
          "data must be writable when IN",
        );
        if (length === 0) break;
        // One storage call per request, straight into the descriptors when
        // they are contiguous.
        const target = gather(data, length);
        if ((await storage.read(offset, target)) !== length) {
          result = BlockDeviceStatus.IOERR;
          break;
        }
        if (target.buffer !== data[0]!.buffer) scatter(target, data);
        n = length;
        break;
      }
      case BlockDeviceRequestType.OUT: {
        assert(
          descs.slice(1, -1).every((desc) => !desc.writable),
          "data must be readonly when OUT",
        );
        if (!storage.write) {
          result = BlockDeviceStatus.UNSUPP;
          break;
        }
        if (length === 0) break;
        // Registered before awaiting, so a flush queued after this request
        // waits for it.
        const write = Promise.resolve(storage.write(offset, gather(data, length)));
        this.#writes.add(write);
        try {
          if ((await write) !== length) result = BlockDeviceStatus.IOERR;
        } finally {
          this.#writes.delete(write);
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
      case BlockDeviceRequestType.GET_ID:
        break;
      default:
        console.error("unknown request type", request.type);
        result = BlockDeviceStatus.UNSUPP;
    }

    status.array[0] = result;
    chain.release(n);
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
 * blockDevice({
 *   capacity: rootfs.byteLength,
 *   read(offset, target) {
 *     const source = rootfs.subarray(offset, offset + target.byteLength);
 *     target.set(source);
 *     return source.byteLength;
 *   },
 * })
 * ```
 */
export function blockDevice(storage: BlockStorage): Device {
  return public_handle(new BlockDevice(storage), {});
}
