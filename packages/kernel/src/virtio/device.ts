// SPDX-License-Identifier: MIT

import { getMachinePlugin, type MachinePlugin, type MachinePluginProvider } from "../plugin.ts";
import { assert } from "../util.ts";
import {
  PackedVirtqueue,
  publish_virtqueue_completion,
  TransportFeatures,
  type Virtqueue,
  type VirtqueueCompletion,
} from "./queue.ts";

const bus_device = Symbol("bus device");

/** A device that can be attached to a machine. */
export interface Device extends MachinePluginProvider {
  /** Settles after the device has stopped and released its backend. */
  readonly closed: Promise<void>;
  /** @internal */
  readonly [bus_device]: BusDevice;
}

/** One attachment of a device to a machine's virtio bus. */
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
  // Hooks for `serveDevice`, which runs a device in a worker. They replace
  // only publication: queue traversal and the device are unchanged, while the
  // main thread retains the final writes to guest memory. A device attached
  // to the machine directly leaves them unset.
  publish_completion?(vq: number, irq: number, completion: VirtqueueCompletion): void;
  queue_is_current?(vq: number): boolean;
  config_target?(length: number): Uint8Array;
  publish_config?(irq: number, config: Uint8Array, interrupt: boolean): void;
}

/**
 * What the bus needs from a device. `VirtioDevice` implements it for devices
 * on this thread; `workerDevice` implements it for a device in a worker.
 */
export interface BusDevice {
  readonly id: number;
  /** Every offered feature, including the transport's. */
  readonly features: bigint;
  readonly config: Uint8Array;
  readonly queues: number;
  readonly closed: Promise<void>;
  attach(context: VirtioConnectionContext): ConnectedVirtioDevice;
  /** Idempotently stops the device and releases its backend. */
  shutdown(): Promise<void>;
}

/** Builds the public handle for a device, merging in its device-specific API. */
export function public_handle<API extends object>(device: BusDevice, api: API): Device & API {
  const plugin: MachinePlugin = {
    configure(setup) {
      setup.devices.add(handle);
    },
  };
  const handle: Device & API = Object.freeze({
    ...api,
    closed: device.closed,
    [bus_device]: device,
    [getMachinePlugin]: () => plugin,
  });
  return handle;
}

export function device_of(handle: Device): BusDevice {
  const device = handle[bus_device];
  assert(device, "not a device");
  return device;
}

export interface VirtioDeviceOptions {
  /** The virtio device ID, such as 1 for net or 3 for console. */
  id: number;
  queues: number;
  /** Device-specific feature bits. The transport's are added automatically. */
  features?: bigint;
  /** The device's configuration space, at most 256 bytes. */
  config?: Uint8Array;
  /**
   * Present readable descriptors as views of guest memory instead of copies.
   * Writable descriptors are always copied, so a device can never write to
   * memory the guest reused after a reset.
   */
  views?: boolean;
}

interface QueueState {
  queue: PackedVirtqueue | undefined;
  /** A kernel notification arrived while its previous kick was in flight. */
  pending: boolean;
  notifying: boolean;
}

/** The base of every device implemented on this side of the bus. */
export abstract class VirtioDevice implements BusDevice {
  readonly id: number;
  readonly features: bigint;
  /** Mutate in place, then call `update_config()`. Its size is fixed. */
  readonly config: Uint8Array;
  readonly queues: number;
  readonly closed: Promise<void>;

  #closed = Promise.withResolvers<void>();
  #stopped = false;
  #active = new Set<Promise<void>>();
  #attached: { config: Uint8Array; raise(): void } | undefined;
  #config_pending = false;
  #views: boolean;
  #on_error: (error: unknown) => void = () => {};

  constructor({
    id,
    queues,
    features = 0n,
    config = new Uint8Array(),
    views = false,
  }: VirtioDeviceOptions) {
    this.id = id;
    this.#views = views;
    this.queues = queues;
    this.features =
      TransportFeatures.VERSION_1 |
      TransportFeatures.RING_PACKED |
      TransportFeatures.INDIRECT_DESC |
      features;
    this.config = config;
    this.closed = this.#closed.promise;
    // Lifecycle promises do not cause unhandled rejections merely because a
    // consumer chooses not to observe them.
    void this.closed.catch(() => {});
  }

  /**
   * Called when the guest notifies `vq`, once per kick, and settled before
   * the next kick on that queue is delivered: kicks that arrive meanwhile are
   * coalesced into one follow-up call. A kick must therefore never await
   * guest activity - more chains, or another kick - because kicks only reach
   * a settled handler. Host data that waits for guest buffers belongs in an
   * `RxQueue`. Awaiting host I/O is fine. Errors are reported to the machine.
   */
  protected abstract kick(vq: number, queue: Virtqueue): void | PromiseLike<void>;

  /** The guest reset the device: drop guest-owned state, keep host state. */
  protected reset(): void {}

  /** Synchronously starts whatever cancellation in-flight kicks need to settle. */
  protected stop(): void {}

  /** Releases the backend, after in-flight kicks have settled. Called once. */
  protected close(): void | PromiseLike<void> {}

  /** Whether the device has started shutting down. */
  protected get stopped() {
    return this.#stopped;
  }

  /** Publishes `config` to the guest and raises a config-change interrupt. */
  protected update_config() {
    if (this.#stopped) return;
    if (!this.#attached) {
      this.#config_pending = true;
      return;
    }
    this.#attached.config.set(this.config);
    this.#attached.raise();
  }

  /**
   * Runs work that outlives its kick, such as a request processed
   * concurrently with later ones. Shutdown waits for it before `close()`, and
   * a failure is reported to the machine like a failed kick.
   */
  protected spawn(work: Promise<void>) {
    this.#active.add(work);
    void work.catch((error) => this.#on_error(error)).finally(() => this.#active.delete(work));
  }

  shutdown(): Promise<void> {
    if (this.#stopped) return this.closed;
    this.#stopped = true;
    void (async () => {
      let failure: PromiseRejectedResult | undefined;
      try {
        this.stop();
      } catch (reason) {
        failure = { status: "rejected", reason };
      }
      // Work in flight may spawn more before it settles.
      while (this.#active.size > 0) {
        const results = await Promise.allSettled(this.#active);
        failure ??= results.find((result) => result.status === "rejected");
      }
      try {
        await this.close();
      } catch (reason) {
        failure ??= { status: "rejected", reason };
      }
      if (failure) throw failure.reason;
    })().then(this.#closed.resolve, this.#closed.reject);
    return this.closed;
  }

  #dispatch(vq: number, queue: Virtqueue): Promise<void> | undefined {
    if (this.#stopped) return;
    assert(vq < this.queues, `virtio device has no queue ${vq}`);
    const completion = Promise.withResolvers<void>();
    // Track the kick before running it, so a kick that reentrantly shuts the
    // device down is still awaited before close().
    this.#active.add(completion.promise);
    try {
      Promise.resolve(this.kick(vq, queue)).then(completion.resolve, completion.reject);
    } catch (error) {
      completion.reject(error);
    }
    void completion.promise.finally(() => this.#active.delete(completion.promise)).catch(() => {});
    return completion.promise;
  }

  attach(context: VirtioConnectionContext): ConnectedVirtioDevice {
    assert(!this.#stopped, "cannot attach a closed virtio device");
    assert(!this.#attached, "virtio device is already attached");
    this.#on_error = context.on_error;
    const queues: QueueState[] = [];
    const queue_state = (vq: number) =>
      (queues[vq] ??= { queue: undefined, pending: false, notifying: false });

    const drain = async (vq: number) => {
      const state = queue_state(vq);
      if (state.notifying || !state.queue) return;
      state.notifying = true;
      try {
        do {
          state.pending = false;
          await this.#dispatch(vq, state.queue);
        } while (state.pending && state.queue);
      } catch (error) {
        context.on_error(error);
      } finally {
        state.notifying = false;
      }
    };

    return {
      set_features: (features) => {
        assert(
          features === this.features,
          "the kernel should accept every feature we offer, and no more",
        );
      },
      setup: (config_irq, config_address, config_length) => {
        assert(config_length >= this.config.byteLength, "config space too small");
        const config = context.config_target
          ? context.config_target(config_length)
          : new Uint8Array(context.memory.buffer, config_address, config_length);
        config.set(this.config);
        this.#attached = {
          config,
          raise: () => {
            if (context.publish_config) context.publish_config(config_irq, config.slice(), true);
            else context.trigger_irq(config_irq);
          },
        };
        context.publish_config?.(config_irq, config.slice(), false);
        if (this.#config_pending) {
          this.#config_pending = false;
          this.update_config();
        }
      },
      enable_queue: (vq, size, descriptor_address, irq) => {
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
            // Batch interrupts for completions published in one turn.
            if (armed) return;
            armed = true;
            queueMicrotask(() => {
              armed = false;
              if (state.queue === queue) context.trigger_irq(irq);
            });
          },
          () => state.queue === queue && (context.queue_is_current?.(vq) ?? true),
          this.#views,
        );
        state.queue = queue;
        if (state.pending) void drain(vq);
      },
      disable_queue: (vq) => {
        const state = queues[vq];
        if (!state) return;
        state.queue?.invalidate();
        state.queue = undefined;
        state.pending = false;
      },
      notify: (vq) => {
        queue_state(vq).pending = true;
        void drain(vq);
      },
      reset: () => {
        for (const state of queues) {
          if (!state) continue;
          state.queue?.invalidate();
          state.queue = undefined;
          state.pending = false;
        }
        if (!this.#stopped) this.reset();
      },
    };
  }
}
