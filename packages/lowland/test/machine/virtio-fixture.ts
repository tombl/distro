// SPDX-License-Identifier: MIT

import { VirtioBus } from "../../src/machine/virtio/bus.ts";
import {
  type Device,
  device_of,
  public_handle,
  VirtioDevice,
} from "../../src/machine/virtio/device.ts";
import type { Virtqueue } from "../../src/machine/virtio/queue.ts";

export type TestQueueHandler = (queue: Virtqueue) => void | PromiseLike<void>;

export interface TestDeviceOptions {
  id?: number;
  config?: Uint8Array;
  views?: boolean;
  queues?: readonly TestQueueHandler[];
  reset?(): void;
  restart?(): void;
  stop?(): void;
  close?(): void | PromiseLike<void>;
}

/** A device whose behavior is supplied by the test. */
export class TestDevice extends VirtioDevice {
  readonly #options: TestDeviceOptions;
  readonly handle: Device;

  constructor(options: TestDeviceOptions = {}) {
    super({
      id: options.id ?? 1,
      queues: options.queues?.length ?? 0,
      config: options.config,
      views: options.views,
    });
    this.#options = options;
    this.handle = public_handle(this, {});
  }

  protected kick(vq: number, queue: Virtqueue) {
    return this.#options.queues![vq]!(queue);
  }

  protected reset() {
    this.#options.reset?.();
  }

  protected restart() {
    this.#options.restart?.();
  }

  protected stop() {
    this.#options.stop?.();
  }

  protected close() {
    return this.#options.close?.();
  }

  set_config(config: Uint8Array) {
    this.config.set(config);
    this.update_config();
  }
}

export function attach_devices({
  devices,
  ...context
}: {
  memory: WebAssembly.Memory;
  devices: readonly Device[];
  trigger_irq: (irq: number) => void;
  on_error: (error: unknown) => void;
}) {
  return new VirtioBus(devices).attach(context);
}

export function close_device(device: Device) {
  return device_of(device).shutdown();
}
