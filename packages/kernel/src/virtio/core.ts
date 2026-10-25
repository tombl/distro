// SPDX-License-Identifier: MIT

import { Struct, U16LE, U32LE, U64LE } from "@lowland/bytes";
import { getMachinePlugin, type MachinePlugin, type MachinePluginProvider } from "../plugin.ts";
import { assert } from "../util.ts";
import type { Imports } from "../wasm.ts";

const TransportFeatures = {
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
  readonly array: Uint8Array;
  /** The buffer's length in bytes. Unlike `array`, reading it allocates nothing. */
  readonly length: number;
  /** Whether the guest driver allows the device to write to this buffer. */
  readonly writable: boolean;
}

/** A chain of descriptors making up one request. */
export interface VirtqueueChain extends Iterable<VirtqueueBuffer> {
  /**
   * Completes the chain, reporting how many bytes the device wrote. Without
   * `data`, the device's writes to the writable buffers' arrays are
   * published. With `data`, its parts are written across the writable
   * buffers in order, straight into guest memory, and the arrays are
   * ignored. `data` must fit in the writable buffers and must not change
   * until this returns.
   */
  release(written: number, data?: readonly Uint8Array[]): void;
}

/**
 * A virtqueue, as seen by a device handler: iterate it to take the chains
 * the guest queued for this kick. Each kick needs a fresh iteration - an
 * iterator is single-shot and stays exhausted once the ring is empty, so
 * never hold one across an `await`.
 */
export interface Virtqueue extends Iterable<VirtqueueChain> {}

/**
 * A device-writable buffer. The device only writes it, so its guest contents
 * are never read. The array is allocated when the device first touches it,
 * and only touched buffers are written back. Copying every buffer eagerly
 * cost the console 16 MiB per kick (256 receive buffers of a 64 KiB page).
 */
class WritableBuffer implements VirtqueueBuffer {
  readonly writable = true;
  readonly address: number;
  #length: number;
  touched: Uint8Array<ArrayBuffer> | null = null;

  constructor(address: number, length: number) {
    this.address = address;
    this.#length = length;
  }

  get length() {
    return this.#length;
  }

  get array() {
    return (this.touched ??= new Uint8Array(this.#length));
  }
}

class Chain implements VirtqueueChain {
  #buffers: Array<VirtqueueBuffer | WritableBuffer>;
  #release: (written: number, outputs: VirtqueueOutput[]) => void;

  constructor(
    memory: WebAssembly.Memory,
    desc: Descriptor[],
    release: (written: number, outputs: VirtqueueOutput[]) => void,
  ) {
    this.#buffers = desc.map((descriptor) => {
      const address = Number(descriptor.addr);
      // Device work may outlive the queue generation across an await. Keep
      // guest memory isolated until release proves the chain is still valid.
      if (descriptor.flags & DescriptorFlags.WRITE)
        return new WritableBuffer(address, descriptor.len);
      return {
        array: new Uint8Array(memory.buffer, address, descriptor.len).slice(),
        length: descriptor.len,
        writable: false,
      };
    });
    this.#release = release;
  }

  release(written: number, data?: readonly Uint8Array[]) {
    if (data) {
      this.#release(written, scatter_outputs(this.#buffers, data));
      return;
    }
    this.#release(
      written,
      this.#buffers.flatMap((buffer) =>
        buffer instanceof WritableBuffer && buffer.touched
          ? [{ address: buffer.address, data: buffer.touched }]
          : [],
      ),
    );
  }

  *[Symbol.iterator]() {
    yield* this.#buffers;
  }
}

/** Splits `data` across the writable buffers in order, as views of `data`. */
function scatter_outputs(
  buffers: readonly (VirtqueueBuffer | WritableBuffer)[],
  data: readonly Uint8Array[],
): VirtqueueOutput[] {
  const outputs: VirtqueueOutput[] = [];
  let part = 0;
  let at = 0;
  for (const buffer of buffers) {
    if (!(buffer instanceof WritableBuffer)) continue;
    let room = buffer.length;
    let address = buffer.address;
    while (room > 0 && part < data.length) {
      const source = data[part]!;
      const n = Math.min(room, source.byteLength - at);
      if (n > 0) outputs.push({ address, data: source.subarray(at, at + n) });
      address += n;
      room -= n;
      at += n;
      if (at === source.byteLength) {
        part++;
        at = 0;
      }
    }
  }
  while (part < data.length && data[part]!.byteLength === at) {
    part++;
    at = 0;
  }
  assert(part === data.length, "virtqueue chain's writable buffers are too small");
  return outputs;
}

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
  // The flags make the descriptor visible to the guest, so publish them last.
  descriptor.flags = completion.flags;
}

class PackedVirtqueue implements Virtqueue {
  #memory: WebAssembly.Memory;
  #size: number;
  #desc_addr: number;
  #publish: (completion: VirtqueueCompletion) => void;
  #is_current: () => boolean;
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
  ) {
    assert(size !== 0);
    this.#memory = memory;
    this.#size = size;
    this.#desc_addr = desc_addr;
    this.#publish = publish;
    this.#is_current = is_current;
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
      if (desc.len % VirtqDescriptor.size !== 0) {
        throw new Error("malformed indirect buffer");
      }
      chain_desc = this.#indirect_descriptors(Number(desc.addr), desc.len / VirtqDescriptor.size);
    }

    const chain = new Chain(this.#memory, chain_desc, (written, outputs) =>
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
    const desc = this.#descriptor(this.#avail_idx);

    const avail = (desc.flags & DescriptorFlags.AVAIL) !== 0;
    const used = (desc.flags & DescriptorFlags.USED) !== 0;
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

type RaiseConfigInterrupt = () => void;

/** The identity, features, and configuration space of a virtio device. */
export interface VirtioDeviceOptions {
  /** The virtio device ID: 1 is net, 3 is console, 4 is entropy. */
  deviceId: number;
  /** Device-specific feature bits; transport features are added automatically. */
  features?: bigint;
  /** The device's configuration space, read by the guest driver. */
  config?: Uint8Array;
}

/**
 * Called when the guest driver notifies a virtqueue, once per kick, and
 * settled before the next kick is delivered: kicks that arrive while a call
 * is settling are coalesced into one follow-up call. A handler must
 * therefore never await guest activity - more chains, or another kick -
 * because kicks only reach a settled handler. Host-side data that awaits
 * guest buffers belongs in device state (JS-side queues, matched up as
 * kicks arrive, as in `console.ts`); awaiting host-side I/O within a call
 * is fine. Errors thrown or rejected here are reported to the machine's
 * error handler.
 */
export type VirtqueueHandler = (
  queue: Virtqueue,
  controller: VirtioController,
) => void | PromiseLike<void>;

/** The behavior of a device behind a `VirtioController`. */
export interface VirtioDriver {
  /** One handler per virtqueue. */
  readonly queues: readonly VirtqueueHandler[];
  /** Drops guest-owned protocol state when the guest resets the device. */
  reset?(): void;
  /** Synchronously starts cancellation needed to unblock queue handlers. */
  stop?(): void;
  /** Called after in-flight queue handlers settle when the device is closed. */
  close?(controller: VirtioController): void | PromiseLike<void>;
}

export interface ConnectedVirtioDevice {
  set_features(features: bigint): void;
  setup(config_irq: number, config_address: number, config_length: number): void;
  enable_queue(vq: number, size: number, descriptor_address: number, irq: number): void;
  disable_queue(vq: number): void;
  notify(vq: number): void;
  reset(): void;
}

export interface VirtioConnectionContext {
  memory: WebAssembly.Memory;
  trigger_irq(irq: number): void;
  on_error(error: unknown): void;
  // A remote connection replaces only publication. Queue traversal and the
  // driver remain unchanged, while the main thread retains the final writes
  // to guest memory. Local connections omit these hooks.
  publish_completion?(vq: number, irq: number, completion: VirtqueueCompletion): void;
  queue_is_current?(vq: number): boolean;
  config_target?(length: number): Uint8Array;
  publish_config?(irq: number, config: Uint8Array, interrupt: boolean): void;
}

export interface TransportDevice {
  readonly device_id: number;
  readonly features: bigint;
  readonly config: Uint8Array;
  readonly queues: number;
  readonly closed: Promise<void>;
  connect(context: VirtioConnectionContext): ConnectedVirtioDevice;
  close(): Promise<void>;
}

const transport_device = Symbol("virtio transport device");

/** A virtio device that can be attached to a machine. */
export interface VirtioDevice extends MachinePluginProvider {
  /** Settles after the device has stopped handling queues and finished cleanup. */
  readonly closed: Promise<void>;
  readonly [transport_device]: TransportDevice;
}

export function create_virtio_device(endpoint: TransportDevice): VirtioDevice {
  const device = {} as VirtioDevice;
  const plugin: MachinePlugin = {
    configure(setup) {
      setup.devices.add(device);
    },
  };
  Object.defineProperty(device, transport_device, { value: endpoint });
  Object.defineProperty(device, getMachinePlugin, { value: () => plugin });
  Object.defineProperty(device, "closed", { value: endpoint.closed, enumerable: true });
  return device;
}

/**
 * The device side of a virtio device: feature negotiation, virtqueues,
 * configuration space, and interrupts. A custom device constructs one with
 * a device ID and queue handlers, and attaches the resulting `device` to
 * the machine.
 */
export class VirtioController {
  /** The attachable device. */
  readonly device: VirtioDevice;
  /** Pushes a new configuration to the guest and raises a config-change interrupt. */
  readonly updateConfig: (config: Uint8Array) => void;
  /** Idempotently starts closing the device. */
  readonly close: () => void;
  /** Merges extra methods into the public device object; callable once. */
  readonly expose: <API extends object>(api: API) => VirtioDevice & API;

  /** Creates a virtio device backed by `driver`. */
  constructor(options: VirtioDeviceOptions, driver: VirtioDriver) {
    const config = options.config?.slice() ?? new Uint8Array();
    let get_guest_config: (() => Uint8Array) | undefined;
    let raise_config: RaiseConfigInterrupt | undefined;
    let config_pending = false;
    let closed = false;
    const close_completion = Promise.withResolvers<void>();
    void close_completion.promise.catch(() => {});
    let close_started = false;
    const active = new Set<Promise<void>>();
    let exposed = false;

    const start_close = () => {
      if (close_started) return close_completion.promise;
      close_started = true;
      closed = true;
      void (async () => {
        let failure: PromiseRejectedResult | undefined;
        try {
          driver.stop?.();
        } catch (reason) {
          failure = { status: "rejected", reason };
        }
        const results = await Promise.allSettled(active);
        failure ??= results.find((result) => result.status === "rejected");
        try {
          await driver.close?.(this);
        } catch (reason) {
          failure ??= { status: "rejected", reason };
        }
        if (failure) throw failure.reason;
      })().then(close_completion.resolve, close_completion.reject);
      return close_completion.promise;
    };

    const features =
      TransportFeatures.VERSION_1 |
      TransportFeatures.RING_PACKED |
      TransportFeatures.INDIRECT_DESC |
      (options.features ?? 0n);
    const endpoint: TransportDevice = {
      device_id: options.deviceId,
      features,
      config,
      queues: driver.queues.length,
      closed: close_completion.promise,
      connect: (context) =>
        connect_local_virtio_device(context, {
          features,
          config,
          attach: (next_get_config, next_raise_config) => {
            assert(!closed, "cannot attach a closed virtio device");
            assert(!get_guest_config, "virtio device is already attached");
            next_get_config().set(config);
            get_guest_config = next_get_config;
            raise_config = next_raise_config;
            if (config_pending) {
              config_pending = false;
              raise_config();
            }
          },
          notify: (vq, queue) => {
            if (closed) return;
            const handler = driver.queues[vq];
            assert(handler, `virtio device has no queue ${vq}`);
            const completion = Promise.withResolvers<void>();
            active.add(completion.promise);
            try {
              Promise.resolve(handler(queue, this)).then(completion.resolve, completion.reject);
            } catch (error) {
              completion.reject(error);
            }
            void completion.promise
              .finally(() => active.delete(completion.promise))
              .catch(() => {});
            return completion.promise;
          },
          reset: () => {
            if (!closed) driver.reset?.();
          },
        }),
      close: start_close,
    };
    this.device = create_virtio_device(endpoint);

    this.updateConfig = (next_config) => {
      assert(next_config.byteLength === config.byteLength, "virtio config size cannot change");
      config.set(next_config);
      get_guest_config?.().set(config);
      if (closed) return;
      if (raise_config) raise_config();
      else config_pending = true;
    };

    this.close = () => void start_close();
    this.expose = <API extends object>(api: API) => {
      assert(!exposed, "virtio device API is already exposed");
      exposed = true;
      Object.defineProperties(this.device, Object.getOwnPropertyDescriptors(api));
      return this.device as VirtioDevice & API;
    };
  }
}

interface VirtqueueState {
  queue: PackedVirtqueue | undefined;
  /** A kernel notification arrived while its previous handler was in flight. */
  pending: boolean;
  notifying: boolean;
}

interface LocalVirtioDevice {
  features: bigint;
  config: Uint8Array;
  attach(get_config: () => Uint8Array, raise_config: RaiseConfigInterrupt): void;
  notify(vq: number, queue: Virtqueue): void | PromiseLike<void>;
  reset(): void;
}

function connect_local_virtio_device(
  context: VirtioConnectionContext,
  device: LocalVirtioDevice,
): ConnectedVirtioDevice {
  const queues: VirtqueueState[] = [];

  const queue_state = (vq: number) =>
    (queues[vq] ??= { queue: undefined, pending: false, notifying: false });

  const drain_notifications = async (vq: number) => {
    const state = queue_state(vq);
    if (state.notifying || !state.queue) return;
    state.notifying = true;
    try {
      do {
        state.pending = false;
        await device.notify(vq, state.queue);
      } while (state.pending && state.queue);
    } catch (error) {
      context.on_error(error);
    } finally {
      state.notifying = false;
    }
  };

  return {
    set_features(features) {
      assert(
        device.features === features,
        "the kernel should accept every feature we offer, and no more",
      );
    },
    setup(config_irq, _config_address, config_length) {
      assert(config_length >= device.config.byteLength, "config space too small");
      const config = context.config_target
        ? context.config_target(config_length)
        : new Uint8Array(context.memory.buffer, _config_address, config_length);
      device.attach(
        () => config,
        () => {
          if (context.publish_config) context.publish_config(config_irq, config.slice(), true);
          else context.trigger_irq(config_irq);
        },
      );
      context.publish_config?.(config_irq, config.slice(), false);
    },
    enable_queue(vq, size, descriptor_address, irq) {
      const state = queue_state(vq);
      state.queue?.invalidate();
      let armed = false;
      const queue = new PackedVirtqueue(
        context.memory,
        size,
        descriptor_address,
        (completion) => {
          if (context.publish_completion) {
            context.publish_completion(vq, irq, completion);
            return;
          }
          publish_virtqueue_completion(context.memory, completion);
          if (armed) return;
          armed = true;
          queueMicrotask(() => {
            armed = false;
            if (state.queue === queue) context.trigger_irq(irq);
          });
        },
        () => state.queue === queue && (context.queue_is_current?.(vq) ?? true),
      );
      state.queue = queue;
      if (state.pending) void drain_notifications(vq);
    },
    disable_queue(vq) {
      const state = queues[vq];
      state?.queue?.invalidate();
      if (!state) return;
      state.queue = undefined;
      state.pending = false;
    },
    notify(vq) {
      queue_state(vq).pending = true;
      void drain_notifications(vq);
    },
    reset() {
      for (const state of queues) {
        if (!state) continue;
        state.queue?.invalidate();
        state.queue = undefined;
        state.pending = false;
      }
      device.reset();
    },
  };
}

export function virtio_device_description(device: VirtioDevice) {
  const transport = device[transport_device];
  return {
    device_id: transport.device_id,
    features: transport.features,
    config: transport.config,
    queues: transport.queues,
  };
}

export function connect_virtio_device(device: VirtioDevice, context: VirtioConnectionContext) {
  return device[transport_device].connect(context);
}

export function close_virtio_device(device: VirtioDevice) {
  return device[transport_device].close();
}

export function virtio_imports({
  memory,
  devices,
  trigger_irq,
  on_error,
}: {
  memory: WebAssembly.Memory;
  devices: readonly VirtioDevice[];
  trigger_irq: (irq: number) => void;
  on_error: (error: unknown) => void;
}): Imports["virtio"] {
  const connected = devices.map((device) =>
    device[transport_device].connect({ memory, trigger_irq, on_error }),
  );

  return {
    set_features(dev, features) {
      const device = connected[dev];
      assert(device);
      device.set_features(features);
    },

    enable_vring(dev, vq, size, desc_addr, irq) {
      const device = connected[dev];
      assert(device);
      device.enable_queue(vq, size, desc_addr >>> 0, irq);
    },
    disable_vring(dev, vq) {
      const device = connected[dev];
      assert(device);
      device.disable_queue(vq);
    },
    reset(dev) {
      const device = connected[dev];
      assert(device);
      device.reset();
    },

    setup(dev, config_irq, config_addr, config_len) {
      const address = config_addr >>> 0;
      const length = config_len >>> 0;
      const device = connected[dev];
      assert(device);
      device.setup(config_irq, address, length);
    },

    notify(dev, vq) {
      const device = connected[dev];
      assert(device);
      device.notify(vq);
    },
  };
}
