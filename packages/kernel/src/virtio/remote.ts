// SPDX-License-Identifier: MIT

import { assert } from "../util.ts";
import { listen_endpoint, post_endpoint, type Endpoint } from "../endpoint.ts";
export type { Endpoint } from "../endpoint.ts";
import {
  type BusDevice,
  type ConnectedVirtioDevice,
  type Device,
  device_of,
  public_handle,
  type VirtioConnectionContext,
} from "./device.ts";
import { publish_virtqueue_completion, type VirtqueueCompletion } from "./queue.ts";

/*
 * The queue protocol deliberately has no request IDs. Transport operations
 * flow to the worker in MessagePort order. Completions flow back in the other
 * direction. Cross-direction queue coordination is the shared revocation array
 * used by reset, plus one acknowledgement per reset once the worker has
 * finished with guest memory. Copied descriptor payloads are transferred back,
 * then committed to guest memory by the main thread; a device with views
 * writes guest memory in place from the worker.
 */

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

type ReadyMessage = {
  type: "ready";
  device_id: number;
  features: bigint;
  config: Uint8Array;
  queues: number;
};

type CompletionMessage = {
  type: "complete";
  vq: number;
  irq: number;
  device_epoch: number;
  queue_epoch: number;
  completion: VirtqueueCompletion;
};

type WorkerMessage =
  | ReadyMessage
  | CompletionMessage
  | { type: "config"; irq: number; config: Uint8Array; interrupt: boolean }
  | { type: "reset_done" }
  | { type: "error"; error: SerializedError }
  | { type: "closed"; error?: SerializedError };

type DeviceMessage =
  | { type: "bind"; memory: WebAssembly.Memory; control: SharedArrayBuffer }
  | { type: "features"; features: bigint }
  | { type: "setup"; config_irq: number; config_length: number }
  | {
      type: "enable";
      vq: number;
      size: number;
      descriptor_address: number;
      irq: number;
      device_epoch: number;
      queue_epoch: number;
    }
  | { type: "disable"; vq: number }
  | { type: "notify"; vq: number }
  | { type: "reset" }
  | { type: "close" };

const serialize_error = (error: unknown): SerializedError => {
  const value = error instanceof Error ? error : new Error(String(error));
  return { name: value.name, message: value.message, stack: value.stack };
};

const deserialize_error = ({ name, message, stack }: SerializedError) => {
  const error = new Error(message);
  error.name = name;
  error.stack = stack;
  return error;
};

/**
 * Creates an attachable virtio device whose driver and queue traversal live in
 * `endpoint`, normally a dedicated Worker serving a device with `serveDevice`.
 *
 * The endpoint may instead be a MessagePort. That form is useful when the
 * caller needs to initialize a worker with other data, or serve several
 * devices from one worker. Closing the device closes this protocol and its
 * driver; ownership of the Worker or MessagePort remains with the caller. The
 * caller must keep that endpoint alive until `device.closed` settles.
 *
 * @example
 * ```ts
 * const device = await workerDevice(new Worker("./disk-worker.js", { type: "module" }));
 * ```
 */
export function workerDevice(endpoint: Endpoint): Promise<Device> {
  endpoint.start?.();

  return new Promise((resolve, reject) => {
    let cleanup = () => {};
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    cleanup = listen_endpoint(endpoint, {
      message(value) {
        const message = value as WorkerMessage;
        if (message?.type === "error") {
          fail(deserialize_error(message.error));
          return;
        }
        if (message?.type !== "ready") return;
        // Install the device's lifetime listeners before removing the startup
        // listeners. No worker failure can fall between ready and attachment.
        const device = create_remote_device(endpoint, message);
        cleanup();
        resolve(device);
      },
      error: fail,
    });
  });
}

function create_remote_device(endpoint: Endpoint, ready: ReadyMessage): Device {
  const config = ready.config.slice();
  const close_completion = Promise.withResolvers<void>();
  void close_completion.promise.catch(() => {});
  let connection: ReturnType<typeof connect_remote_device> | undefined;
  let terminal_error: Error | undefined;
  let close_started = false;

  let cleanup = () => {};
  const fail = (error: Error) => {
    terminal_error ??= error;
    connection?.fail(error);
    close_completion.reject(error);
  };
  const receive = (value: unknown) => {
    const message = value as WorkerMessage;
    if (message?.type === "closed") {
      cleanup();
      connection?.revoke();
      // The worker has drained its device, so nothing touches guest memory.
      connection?.release_resets();
      if (message.error) {
        const error = deserialize_error(message.error);
        connection?.fail(error);
        close_completion.reject(error);
      } else {
        close_completion.resolve();
      }
      return;
    }
    if (message?.type === "error" && !connection) {
      fail(deserialize_error(message.error));
      return;
    }
    connection?.receive(message);
  };
  const endpoint_failure = (error: Error) => {
    cleanup();
    fail(error);
  };
  cleanup = listen_endpoint(endpoint, {
    message: receive,
    error: endpoint_failure,
  });

  const transport: BusDevice = {
    id: ready.device_id,
    features: ready.features,
    config,
    queues: ready.queues,
    closed: close_completion.promise,
    attach(context) {
      assert(!connection, "remote virtio device is already attached");
      if (terminal_error) throw terminal_error;
      connection = connect_remote_device(endpoint, transport, context);
      return connection.device;
    },
    shutdown() {
      if (close_started) return close_completion.promise;
      close_started = true;
      connection?.revoke();
      post_endpoint(endpoint, { type: "close" } satisfies DeviceMessage);
      return close_completion.promise;
    },
  };
  return public_handle(transport, {});
}

function connect_remote_device(
  endpoint: Endpoint,
  transport: BusDevice,
  context: VirtioConnectionContext,
) {
  // Slot zero revokes the whole device; the remaining slots revoke individual
  // queues. Reset changes slot zero synchronously on the main thread. A worker
  // may finish old work, but its completion cannot pass the main-thread check.
  const control_buffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * (1 + transport.queues),
  );
  const control = new Int32Array(control_buffer);
  const queue_epochs = new Int32Array(transport.queues);
  const enabled = new Uint8Array(transport.queues);
  let config_target: Uint8Array | undefined;
  let failed = false;
  // Resets the worker has not yet acknowledged, oldest first. Only the
  // worker can say it has finished with guest memory: a reset is released by
  // its acknowledgement or by the worker's report that its device has closed,
  // never by revocation or failure alone. A worker that never answers leaves
  // the guest waiting, which is harmless once the machine has failed.
  const resets: (() => void)[] = [];

  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    Atomics.add(control, 0, 1);
    context.on_error(error);
  };

  const receive = (message: WorkerMessage) => {
    switch (message?.type) {
      case "complete": {
        if (
          !enabled[message.vq] ||
          Atomics.load(control, 0) !== message.device_epoch ||
          Atomics.load(control, 1 + message.vq) !== message.queue_epoch
        )
          return;
        publish_virtqueue_completion(context.memory, message.completion);
        context.trigger_irq(message.irq);
        return;
      }
      case "config":
        transport.config.set(message.config.subarray(0, transport.config.byteLength));
        config_target?.set(message.config);
        if (message.interrupt) context.trigger_irq(message.irq);
        return;
      case "reset_done":
        resets.shift()?.();
        return;
      case "error":
        fail(deserialize_error(message.error));
        return;
    }
  };
  post_endpoint(endpoint, {
    type: "bind",
    memory: context.memory,
    control: control_buffer,
  } satisfies DeviceMessage);

  const device: ConnectedVirtioDevice = {
    set_features(features) {
      assert(features === transport.features);
      post_endpoint(endpoint, { type: "features", features } satisfies DeviceMessage);
    },
    setup(config_irq, config_address, config_length) {
      assert(config_length >= transport.config.byteLength, "config space too small");
      config_target = new Uint8Array(context.memory.buffer, config_address, config_length);
      config_target.set(transport.config);
      post_endpoint(endpoint, { type: "setup", config_irq, config_length } satisfies DeviceMessage);
    },
    enable_queue(vq, size, descriptor_address, irq) {
      assert(vq < transport.queues, `virtio device has no queue ${vq}`);
      Atomics.add(control, 1 + vq, 1);
      const queue_epoch = (queue_epochs[vq] = Atomics.load(control, 1 + vq));
      const device_epoch = Atomics.load(control, 0);
      enabled[vq] = 1;
      post_endpoint(endpoint, {
        type: "enable",
        vq,
        size,
        descriptor_address,
        irq,
        device_epoch,
        queue_epoch,
      } satisfies DeviceMessage);
    },
    disable_queue(vq) {
      assert(vq < transport.queues, `virtio device has no queue ${vq}`);
      enabled[vq] = 0;
      Atomics.add(control, 1 + vq, 1);
      post_endpoint(endpoint, { type: "disable", vq } satisfies DeviceMessage);
    },
    notify(vq) {
      post_endpoint(endpoint, { type: "notify", vq } satisfies DeviceMessage);
    },
    reset() {
      // This executes inside the synchronous Wasm import. Since completions are
      // also committed on this thread, none can interleave between revocation
      // and the rest of reset. The worker may still be touching guest memory
      // in place, though, so the guest waits for it to say it has finished.
      Atomics.add(control, 0, 1);
      enabled.fill(0);
      const done = new Promise<void>((resolve) => resets.push(resolve));
      post_endpoint(endpoint, { type: "reset" } satisfies DeviceMessage);
      return done;
    },
  };

  return {
    device,
    receive,
    fail,
    revoke() {
      Atomics.add(control, 0, 1);
      enabled.fill(0);
    },
    release_resets() {
      for (const resolve of resets.splice(0)) resolve();
    },
  };
}

/**
 * Serves `device` over `endpoint` for `workerDevice` to attach to a machine.
 * In a dedicated worker, the usual endpoint is `self`; a MessagePort is useful
 * when the worker needs other initialization or serves more than one device.
 *
 * @example
 * ```ts
 * serveDevice(self, blockDevice(storage));
 * ```
 */
export function serveDevice(endpoint: Endpoint, handle: Device): void {
  const device = device_of(handle);
  const description = {
    device_id: device.id,
    features: device.features,
    config: device.config,
    queues: device.queues,
  };
  let connected: ConnectedVirtioDevice | undefined;
  let control: Int32Array | undefined;
  let device_epoch = 0;
  const queue_epochs = new Int32Array(description.queues);
  let closing = false;

  const send_error = (error: unknown) =>
    post_endpoint(endpoint, {
      type: "error",
      error: serialize_error(error),
    } satisfies WorkerMessage);

  let stop_listening = () => {};
  const on_message = (value: unknown) => {
    const message = value as DeviceMessage;
    try {
      switch (message?.type) {
        case "bind":
          assert(!connected, "virtio device is already bound");
          message.memory.grow(0);
          control = new Int32Array(message.control);
          connected = device.attach({
            memory: message.memory,
            trigger_irq: () => assert(false, "remote interrupts are published with state"),
            on_error: send_error,
            config_target: (length) => new Uint8Array(length),
            publish_config: (irq, value, interrupt) => {
              const copy = value.slice();
              post_endpoint(
                endpoint,
                { type: "config", irq, config: copy, interrupt } satisfies WorkerMessage,
                [copy.buffer],
              );
            },
            queue_is_current: (vq) =>
              Atomics.load(control!, 0) === device_epoch &&
              Atomics.load(control!, 1 + vq) === queue_epochs[vq],
            publish_completion: (vq, irq, completion) => {
              if (
                Atomics.load(control!, 0) !== device_epoch ||
                Atomics.load(control!, 1 + vq) !== queue_epochs[vq]
              )
                return;
              // A chain's outputs may share one buffer, which can be transferred once.
              const transfer = [...new Set(completion.outputs.map(({ data }) => data.buffer))];
              post_endpoint(
                endpoint,
                {
                  type: "complete",
                  vq,
                  irq,
                  device_epoch,
                  queue_epoch: queue_epochs[vq]!,
                  completion,
                } satisfies WorkerMessage,
                transfer,
              );
            },
          });
          return;
        case "features":
          connected?.set_features(message.features);
          return;
        case "setup":
          connected?.setup(message.config_irq, 0, message.config_length);
          return;
        case "enable":
          device_epoch = message.device_epoch;
          queue_epochs[message.vq] = message.queue_epoch;
          connected?.enable_queue(
            message.vq,
            message.size,
            message.descriptor_address,
            message.irq,
          );
          return;
        case "disable":
          connected?.disable_queue(message.vq);
          return;
        case "notify":
          connected?.notify(message.vq);
          return;
        case "reset":
          device_epoch = Atomics.load(control!, 0);
          void (connected?.reset() ?? Promise.resolve()).then(() =>
            post_endpoint(endpoint, { type: "reset_done" } satisfies WorkerMessage),
          );
          return;
        case "close":
          if (closing) return;
          closing = true;
          void device.shutdown().then(
            () => {
              stop_listening();
              post_endpoint(endpoint, { type: "closed" } satisfies WorkerMessage);
            },
            (error) => {
              stop_listening();
              post_endpoint(endpoint, {
                type: "closed",
                error: serialize_error(error),
              } satisfies WorkerMessage);
            },
          );
          return;
      }
    } catch (error) {
      send_error(error);
    }
  };

  stop_listening = listen_endpoint(endpoint, { message: on_message });
  endpoint.start?.();
  const ready_config = description.config.slice();
  post_endpoint(
    endpoint,
    { type: "ready", ...description, config: ready_config } satisfies WorkerMessage,
    [ready_config.buffer],
  );
}
