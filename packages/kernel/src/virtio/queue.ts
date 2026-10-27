// SPDX-License-Identifier: MIT

import { Struct, U16LE, U32LE, U64LE } from "@lowland/bytes";
import { assert } from "../util.ts";

export const TransportFeatures = {
  VERSION_1: 1n << 32n,
  RING_PACKED: 1n << 34n,
  INDIRECT_DESC: 1n << 28n,
} as const;

const DescriptorFlags = {
  NEXT: 1 << 0,
  WRITE: 1 << 1,
  INDIRECT: 1 << 2,
  AVAIL: 1 << 7,
  USED: 1 << 15,
} as const;

class VirtqDescriptor extends Struct({
  addr: U64LE,
  len: U32LE,
  id: U16LE,
  flags: U16LE,
}) {}

interface Descriptor {
  addr: bigint;
  len: number;
  id: number;
  flags: number;
}

/** One descriptor's view into the machine's memory. */
export interface VirtqueueBuffer {
  /**
   * The descriptor's bytes: a private copy. A writable copy starts zeroed,
   * not with the guest's contents, and release writes back only the bytes it
   * reports as written. On a queue created with views it is guest memory
   * itself, which the device must stop touching once it releases the chain.
   */
  readonly array: Uint8Array;
  /** Whether the guest driver allows the device to write to this buffer. */
  readonly writable: boolean;
}

/** A chain of descriptors making up one request. */
export interface VirtqueueChain extends Iterable<VirtqueueBuffer> {
  /** Completes the chain, reporting how many bytes the device wrote. */
  release(written: number): void;
}

/**
 * A virtqueue, as seen by a device handler: iterate it to take the chains
 * the guest queued for this kick. Each kick needs a fresh iteration - an
 * iterator is single-shot and stays exhausted once the ring is empty, so
 * never hold one across an `await`.
 */
export interface Virtqueue extends Iterable<VirtqueueChain> {}

class Chain implements VirtqueueChain {
  #buffers: VirtqueueBuffer[];
  #writable: { address: number; offset: number; length: number }[] = [];
  #writable_length = 0;
  #scratch: ArrayBuffer | undefined;
  #release: (written: number, outputs: VirtqueueOutput[]) => void;

  constructor(
    memory: WebAssembly.Memory,
    desc: Descriptor[],
    views: boolean,
    release: (written: number, outputs: VirtqueueOutput[]) => void,
  ) {
    // Readable copies share one allocation in chain order, as do writable
    // ones, so adjacent descriptors are adjacent views a device can hand to
    // storage in one call.
    const readable = new ArrayBuffer(
      views
        ? 0
        : desc.reduce(
            (total, descriptor) =>
              descriptor.flags & DescriptorFlags.WRITE ? total : total + descriptor.len,
            0,
          ),
    );
    let readable_offset = 0;
    this.#buffers = desc.map((descriptor) => {
      const address = Number(descriptor.addr);
      const writable = (descriptor.flags & DescriptorFlags.WRITE) !== 0;
      // A view is safe across awaits only because reset waits for the
      // device to finish with it. Otherwise device work that outlives the
      // queue generation works on a copy, written back only when release
      // proves the chain is still valid.
      if (views) {
        return { array: new Uint8Array(memory.buffer, address, descriptor.len), writable };
      }
      if (writable) {
        // The device never reads a writable buffer's guest contents, so its
        // copy starts zeroed and is allocated only once the device touches
        // it. A console posts 256 receive buffers of 64 KiB; copying them
        // all in cost 16 MiB per kick.
        const span = { address, offset: this.#writable_length, length: descriptor.len };
        this.#writable.push(span);
        this.#writable_length += descriptor.len;
        let array: Uint8Array<ArrayBuffer> | undefined;
        const chain = this;
        return {
          get array() {
            return (array ??= new Uint8Array(chain.#allocate(), span.offset, span.length));
          },
          writable,
        };
      }
      const copy = new Uint8Array(readable, readable_offset, descriptor.len);
      readable_offset += descriptor.len;
      copy.set(new Uint8Array(memory.buffer, address, descriptor.len));
      return { array: copy, writable };
    });
    this.#release = release;
  }

  #allocate() {
    return (this.#scratch ??= new ArrayBuffer(this.#writable_length));
  }

  release(written: number) {
    // The device reports how many bytes it wrote from the start of the
    // writable buffers, and the driver may not rely on anything past them,
    // so only those are written back.
    const outputs: VirtqueueOutput[] = [];
    const scratch = this.#scratch;
    if (scratch) {
      for (const { address, offset, length } of this.#writable) {
        if (offset >= written) break;
        outputs.push({
          address,
          data: new Uint8Array(scratch, offset, Math.min(length, written - offset)),
        });
      }
    }
    this.#release(written, outputs);
  }

  *[Symbol.iterator]() {
    yield* this.#buffers;
  }
}

// The flags make a descriptor visible to the other side, so they are written
// with a release store after the rest of it and read with an acquire load
// before the rest of it. Descriptors are 16-byte aligned, so the flags are a
// naturally aligned 16-bit word.
const FLAGS_OFFSET = 14;
const flags_index = (memory: WebAssembly.Memory, descriptor_address: number) => {
  const flags = new Uint16Array(memory.buffer);
  return [flags, (descriptor_address + FLAGS_OFFSET) >>> 1] as const;
};

export interface VirtqueueOutput {
  address: number;
  data: Uint8Array;
}

export interface VirtqueueCompletion {
  descriptor_address: number;
  id: number;
  written: number;
  flags: number;
  outputs: VirtqueueOutput[];
}

export function publish_virtqueue_completion(
  memory: WebAssembly.Memory,
  completion: VirtqueueCompletion,
) {
  for (const { address, data } of completion.outputs) {
    new Uint8Array(memory.buffer, address, data.byteLength).set(data);
  }

  const descriptor = VirtqDescriptor.get(
    new DataView(memory.buffer),
    completion.descriptor_address,
  );
  descriptor.id = completion.id;
  descriptor.len = completion.written;
  Atomics.store(...flags_index(memory, completion.descriptor_address), completion.flags);
}

export class PackedVirtqueue implements Virtqueue {
  #memory: WebAssembly.Memory;
  #size: number;
  #desc_addr: number;
  #publish: (completion: VirtqueueCompletion) => void;
  #is_current: () => boolean;
  #views: boolean;
  #avail_wrap = true;
  #used_wrap = true;
  #used_idx = 0;
  #avail_idx = 0;
  #valid = true;

  constructor(
    memory: WebAssembly.Memory,
    size: number,
    desc_addr: number,
    publish: (completion: VirtqueueCompletion) => void,
    is_current: () => boolean = () => true,
    views = false,
  ) {
    assert(size !== 0);
    assert(desc_addr % VirtqDescriptor.size === 0, "packed ring must be 16-byte aligned");
    this.#memory = memory;
    this.#size = size;
    this.#desc_addr = desc_addr;
    this.#publish = publish;
    this.#is_current = is_current;
    this.#views = views;
  }

  invalidate() {
    this.#valid = false;
  }

  #descriptor(index: number) {
    const desc = VirtqDescriptor.get(
      new DataView(this.#memory.buffer),
      this.#desc_addr + VirtqDescriptor.size * index,
    );
    return {
      addr: desc.addr,
      len: desc.len,
      id: desc.id,
      flags: desc.flags,
    };
  }

  #indirect_descriptors(address: number, count: number) {
    const descriptors: Descriptor[] = [];
    for (let i = 0; i < count; i++) {
      const desc = VirtqDescriptor.get(
        new DataView(this.#memory.buffer),
        address + VirtqDescriptor.size * i,
      );
      descriptors.push({
        addr: desc.addr,
        len: desc.len,
        id: desc.id,
        flags: desc.flags,
      });
    }
    return descriptors;
  }

  #pop() {
    let i = this.#advance();
    if (i === null) return null;

    let desc = this.#descriptor(i);
    const id = desc.id;
    let skip = 1;
    let chain_desc = [desc];

    if (desc.flags & DescriptorFlags.NEXT) {
      do {
        i = this.#advance();
        if (i === null) throw new Error("no next descriptor is available");
        desc = this.#descriptor(i);
        chain_desc.push(desc);
        skip += 1;
      } while (desc.flags & DescriptorFlags.NEXT);
    } else if (desc.flags & DescriptorFlags.INDIRECT) {
      const count = desc.len / VirtqDescriptor.size;
      // Bounds host allocation for a malformed table. Linux's lists for the
      // devices offered here (block, fs, net, vsock, console) fit in the queue.
      if (!Number.isInteger(count) || count > this.#size) {
        throw new Error("malformed indirect buffer");
      }
      chain_desc = this.#indirect_descriptors(Number(desc.addr), count);
    }

    const chain = new Chain(this.#memory, chain_desc, this.#views, (written, outputs) =>
      this.#release(id, skip, written, outputs),
    );
    // A remote reset can revoke this queue while its descriptors are being
    // copied. Never expose a mixture of the old and replacement queue to the
    // device; advancing the stale cursor is harmless because reset replaces it.
    return this.#is_current() ? chain : null;
  }

  *[Symbol.iterator]() {
    let chain;
    while (this.#valid && this.#is_current() && (chain = this.#pop())) yield chain;
  }

  #advance() {
    const flags = Atomics.load(
      ...flags_index(this.#memory, this.#desc_addr + VirtqDescriptor.size * this.#avail_idx),
    );

    const avail = (flags & DescriptorFlags.AVAIL) !== 0;
    const used = (flags & DescriptorFlags.USED) !== 0;
    if (avail === used || avail !== this.#avail_wrap) return null;

    const index = this.#avail_idx;
    this.#avail_idx += 1;
    if (this.#avail_idx >= this.#size) {
      this.#avail_idx = 0;
      this.#avail_wrap = !this.#avail_wrap;
    }
    return index;
  }

  #release(id: number, skip: number, written: number, outputs: VirtqueueOutput[]) {
    if (!this.#valid || !this.#is_current()) return;

    const desc = VirtqDescriptor.get(
      new DataView(this.#memory.buffer),
      this.#desc_addr + VirtqDescriptor.size * this.#used_idx,
    );
    const avail = (desc.flags & DescriptorFlags.AVAIL) !== 0;
    const used = (desc.flags & DescriptorFlags.USED) !== 0;
    if (avail === used || avail !== this.#used_wrap) {
      throw new Error("ring full");
    }

    let flags = 0;
    if (this.#used_wrap) flags |= DescriptorFlags.AVAIL | DescriptorFlags.USED;
    if (written > 0) flags |= DescriptorFlags.WRITE;

    const completion: VirtqueueCompletion = {
      descriptor_address: this.#desc_addr + VirtqDescriptor.size * this.#used_idx,
      id,
      written,
      flags,
      outputs,
    };

    this.#used_idx += skip;
    if (this.#used_idx >= this.#size) {
      this.#used_idx -= this.#size;
      this.#used_wrap = !this.#used_wrap;
    }

    this.#publish(completion);
  }
}
