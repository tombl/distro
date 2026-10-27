// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { blockDevice } from "../src/virtio/block.ts";
import type { Device } from "../src/virtio/device.ts";
import { consoleDevice } from "../src/virtio/console.ts";
import { fileSystemDevice } from "../src/virtio/fs.ts";
import { ethernetDevice, ethernetNetwork } from "../src/virtio/net.ts";
import { vsockDevice } from "../src/virtio/vsock.ts";
import { serveDevice, serveDeviceError, workerDevice } from "../src/virtio/remote.ts";
import { attach_devices, close_device, TestDevice } from "./virtio-fixture.ts";
import {
  allocate_shared_memory,
  create_halt_error,
  HALT_KERNEL,
  memory_bytes,
  uncatchable,
  user_module_imports_supported,
  type UserWidth,
} from "../src/wasm.ts";
import { read_wasm_function_imports } from "../src/wasm_binary.ts";

// Assembles WebAssembly text with wasm-tools, which the Nix devshell provides.
function wat(source: string) {
  try {
    return new Uint8Array(execFileSync("wasm-tools", ["parse"], { input: source }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("wasm-tools is not on PATH; run the tests inside `nix develop`");
    }
    throw error;
  }
}

const memory = new WebAssembly.Memory({
  initial: 1,
  maximum: 1,
  shared: true,
});

test("guest exception handlers cannot catch exit or exec halts", () => {
  // (module (import "host" "stop" (func $stop))
  //   (func (export "caught") (result i32)
  //     (try (result i32) (do (call $stop) (i32.const 0))
  //       (catch_all (i32.const 1)))))
  // Built with wat2wasm --enable-exceptions; catch_all models C++ catch (...).
  const hex =
    "0061736d010000000108026000006000017f020d0104686f73740473746f700000" +
    "03020101070a010663617567687400010a0e010c00067f100041001941010b0b";
  const guest = new WebAssembly.Module(
    Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16)),
  );
  const run = (value: unknown) =>
    (
      new WebAssembly.Instance(guest, {
        host: {
          stop: () => {
            throw value;
          },
        },
      }).exports.caught as () => number
    )();

  assert.equal(run(Symbol("old halt")), 1);
  for (const halt of [
    HALT_KERNEL,
    create_halt_error("halt user"),
    uncatchable(new RangeError("bad function pointer")),
  ]) {
    assert.throws(
      () => run(halt),
      (error) => error === halt,
    );
  }
});

function allocator_succeeding_at(successful_maximum: number, attempts: number[]) {
  return (descriptor: WebAssembly.MemoryDescriptor) => {
    attempts.push(descriptor.maximum!);
    if (descriptor.maximum !== successful_maximum) throw new RangeError();
    return memory;
  };
}

test("shared memory allocation backs off by halves", () => {
  const attempts: number[] = [];
  const allocated = allocate_shared_memory(100, 1000, allocator_succeeding_at(250, attempts));

  assert.deepEqual(attempts, [1000, 500, 250]);
  assert.strictEqual(allocated.memory, memory);
  assert.equal(allocated.maximum_pages, 250);
});

test("the initial size is the floor", () => {
  const attempts: number[] = [];
  const allocated = allocate_shared_memory(100, 1000, allocator_succeeding_at(100, attempts));

  assert.deepEqual(attempts, [1000, 500, 250, 125, 100]);
  assert.equal(allocated.maximum_pages, 100);
});

test("a RangeError at the initial size is propagated", () => {
  const attempts: number[] = [];
  const error = new RangeError("out of memory");

  assert.throws(
    () =>
      allocate_shared_memory(100, 1000, (descriptor) => {
        attempts.push(descriptor.maximum!);
        throw error;
      }),
    (thrown) => thrown === error,
  );
  assert.deepEqual(attempts, [1000, 500, 250, 125, 100]);
});

test("a non-RangeError is propagated without retrying", () => {
  const attempts: number[] = [];
  const error = new TypeError("invalid descriptor");

  assert.throws(
    () =>
      allocate_shared_memory(100, 1000, (descriptor) => {
        attempts.push(descriptor.maximum!);
        throw error;
      }),
    (thrown) => thrown === error,
  );
  assert.deepEqual(attempts, [1000]);
});

test("memory views include growth performed by another worker", async () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 2,
    shared: true,
  });
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      workerData.grow(1);
      parentPort.postMessage(workerData.buffer.byteLength);
    `,
    { eval: true, workerData: memory },
  );

  try {
    const [worker_length] = await once(worker, "message");
    assert.equal(worker_length, 2 * 0x10000);

    const bytes = memory_bytes(memory, 0x10000);
    assert.equal(bytes?.byteLength, 0x10000);
    assert.equal(memory_bytes(memory, 2 * 0x10000, 1), null);
  } finally {
    await worker.terminate();
  }
});

// Imports linux.syscall, linux.get_thread_area and linux.copy_siginfo with
// slots, pointers and longs of the given width.
function user_abi_module(width: UserWidth) {
  return wat(`
    (module
      (import "env" "memory" (memory 1 1 shared))
      (import "linux" "syscall"
        (func (param ${width} ${width} ${width} ${width} ${width} ${width} ${width}) (result ${width})))
      (import "linux" "get_thread_area" (func (result ${width})))
      (import "linux" "copy_siginfo" (func (param ${width}) (result i32))))
  `);
}

const user_abi_modules = {
  i32: user_abi_module("i32"),
  i64: user_abi_module("i64"),
};

function supported(bytes: Uint8Array<ArrayBuffer>, width: UserWidth) {
  return user_module_imports_supported(new WebAssembly.Module(bytes), bytes, width);
}

test("userspace modules may only import the supported host ABI", () => {
  const unsupported = wat(`
    (module
      (import "env" "memory" (memory 1 1 shared))
      (import "evil" "f" (func (param i32 i32 i32 i32 i32 i32 i32) (result i32))))
  `);

  assert.equal(supported(user_abi_modules.i32, "i32"), true);
  assert.equal(supported(unsupported, "i32"), false);
});

test("userspace imports must match the width of the user memory", () => {
  assert.equal(supported(user_abi_modules.i64, "i64"), true);
  assert.equal(supported(user_abi_modules.i64, "i32"), false);
  assert.equal(supported(user_abi_modules.i32, "i64"), false);
});

test("function import signatures are read through GC type groups", () => {
  // A recursive group holding a struct type, then the syscall function type.
  const module = wat(`
    (module
      (rec
        (type (struct (field (mut i8))))
        (type (sub (func (param i64 i64 i64 i64 i64 i64 i64) (result i64)))))
      (import "env" "memory" (memory 1 1 shared))
      (import "linux" "syscall" (func (type 1))))
  `);

  assert.deepEqual(read_wasm_function_imports(module), [
    { module: "linux", name: "syscall", type: "i64,i64,i64,i64,i64,i64,i64->i64" },
  ]);
});

test("closing an Ethernet network drops traffic from attached ports", async () => {
  const network = ethernetNetwork();
  let received = 0;
  const sender = network.addPort(() => {});
  network.addPort(() => {
    received += 1;
  });
  const frame = Uint8Array.from([
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08, 0x00,
  ]);

  await sender.send(frame);
  assert.equal(received, 1);

  network.close();
  await sender.send(frame);
  assert.equal(received, 1);
  assert.throws(() => network.addPort(() => {}));
});

test("virtio-net preserves pending frames but drops receive chains on reset", async () => {
  const network = ethernetNetwork();
  const device = ethernetDevice(network, {
    macAddress: [0x02, 0, 0, 0, 0, 1],
  });
  const sender = network.addPort(() => {});
  const net_memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const imports = attach_devices({
    memory: net_memory,
    devices: [device],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const queue_receive = (ring: number, address: number) => {
    const descriptor = new DataView(net_memory.buffer, ring, 16);
    descriptor.setBigUint64(0, BigInt(address), true);
    descriptor.setUint32(8, 64, true);
    descriptor.setUint16(12, 0, true);
    descriptor.setUint16(14, (1 << 7) | (1 << 1), true);
  };

  queue_receive(0, 64);
  imports.enable_vring(0, 0, 1, 0, 1);
  imports.notify(0, 0);
  imports.reset(0, 0);
  imports.disable_vring(0, 0);

  const frame = Uint8Array.from([0x02, 0, 0, 0, 0, 1, 0x02, 0, 0, 0, 0, 2, 0x08, 0x00]);
  await sender.send(frame);
  assert.deepEqual([...new Uint8Array(net_memory.buffer, 64, 26)], Array(26).fill(0));

  queue_receive(128, 256);
  imports.enable_vring(0, 0, 1, 128, 2);
  imports.notify(0, 0);
  await Promise.resolve();
  assert.deepEqual([...new Uint8Array(net_memory.buffer, 256 + 12, frame.byteLength)], [...frame]);

  sender.close();
  await close_device(device);
  network.close();
});

test("virtio block reports a short caller-buffer read as IOERR", async () => {
  const block_memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const device = blockDevice({
    capacity: 512,
    read(_offset, target) {
      target.fill(0xaa);
      return target.byteLength - 1;
    },
  });
  const interrupted = Promise.withResolvers<void>();
  const imports = attach_devices({
    memory: block_memory,
    devices: [device],
    trigger_irq() {
      interrupted.resolve();
    },
    on_error(error) {
      interrupted.reject(error);
    },
  });
  const descriptor = (index: number, address: number, length: number, flags: number) => {
    const view = new DataView(block_memory.buffer, index * 16, 16);
    view.setBigUint64(0, BigInt(address), true);
    view.setUint32(8, length, true);
    view.setUint16(14, flags, true);
  };
  const available = 1 << 7;
  const next = 1;
  const writable = 1 << 1;
  descriptor(0, 128, 16, available | next);
  descriptor(1, 256, 512, available | next | writable);
  descriptor(2, 1024, 1, available | writable);
  new Uint8Array(block_memory.buffer, 1024, 1)[0] = 0xff;

  imports.enable_vring(0, 0, 4, 0, 1);
  imports.notify(0, 0);
  await interrupted.promise;

  assert.equal(new Uint8Array(block_memory.buffer, 1024, 1)[0], 1);
  // Every byte the used length covers is initialized: the unread tail is zeroed.
  const payload = new Uint8Array(block_memory.buffer, 256, 512);
  assert.ok(payload.subarray(0, 511).every((byte) => byte === 0xaa));
  assert.equal(payload[511], 0);
  assert.equal(new DataView(block_memory.buffer, 0, 16).getUint32(8, true), 513);
  await close_device(device);
});

test("virtio block counts every writable buffer of an unsupported request", async () => {
  const block_memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const device = blockDevice({ capacity: 512, read: (_offset, target) => target.byteLength });
  const interrupted = Promise.withResolvers<void>();
  const imports = attach_devices({
    memory: block_memory,
    devices: [device],
    trigger_irq() {
      interrupted.resolve();
    },
    on_error(error) {
      interrupted.reject(error);
    },
  });
  const descriptor = (index: number, address: number, length: number, flags: number) => {
    const view = new DataView(block_memory.buffer, index * 16, 16);
    view.setBigUint64(0, BigInt(address), true);
    view.setUint32(8, length, true);
    view.setUint16(14, flags, true);
  };
  const available = 1 << 7;
  const next = 1;
  const writable = 1 << 1;
  new DataView(block_memory.buffer).setUint32(128, 99, true);
  descriptor(0, 128, 16, available | next);
  descriptor(1, 256, 4, available | next);
  descriptor(2, 512, 8, available | next | writable);
  descriptor(3, 1024, 1, available | writable);
  new Uint8Array(block_memory.buffer, 512, 8).fill(0xff);
  new Uint8Array(block_memory.buffer, 1024, 1)[0] = 0xff;

  imports.enable_vring(0, 0, 8, 0, 1);
  imports.notify(0, 0);
  await interrupted.promise;

  assert.equal(new Uint8Array(block_memory.buffer, 1024, 1)[0], 2);
  assert.deepEqual(new Uint8Array(block_memory.buffer, 512, 8).slice(), new Uint8Array(8));
  assert.equal(new DataView(block_memory.buffer, 0, 16).getUint32(8, true), 9);
  await close_device(device);
});

test("virtio block answers GET_ID with its NUL-padded serial", async () => {
  const block_memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const device = blockDevice(
    { capacity: 512, read: (_offset, target) => target.byteLength },
    { serial: "m1" },
  );
  const interrupted = Promise.withResolvers<void>();
  const imports = attach_devices({
    memory: block_memory,
    devices: [device],
    trigger_irq() {
      interrupted.resolve();
    },
    on_error(error) {
      interrupted.reject(error);
    },
  });
  const descriptor = (index: number, address: number, length: number, flags: number) => {
    const view = new DataView(block_memory.buffer, index * 16, 16);
    view.setBigUint64(0, BigInt(address), true);
    view.setUint32(8, length, true);
    view.setUint16(14, flags, true);
  };
  const available = 1 << 7;
  const next = 1;
  const writable = 1 << 1;
  const get_id = 8;
  new DataView(block_memory.buffer).setUint32(128, get_id, true);
  descriptor(0, 128, 16, available | next);
  descriptor(1, 256, 20, available | next | writable);
  descriptor(2, 1024, 1, available | writable);
  new Uint8Array(block_memory.buffer, 256, 20).fill(0xff);
  new Uint8Array(block_memory.buffer, 1024, 1)[0] = 0xff;

  imports.enable_vring(0, 0, 4, 0, 1);
  imports.notify(0, 0);
  await interrupted.promise;

  const id = new Uint8Array(20);
  id.set(new TextEncoder().encode("m1"));
  assert.deepEqual(new Uint8Array(block_memory.buffer, 256, 20).slice(), id);
  assert.equal(new Uint8Array(block_memory.buffer, 1024, 1)[0], 0);
  // The used element replaces descriptor 0; its length covers the ID and
  // the status byte.
  assert.equal(new DataView(block_memory.buffer, 0, 16).getUint32(8, true), 21);
  await close_device(device);
});

test("virtio block rejects a serial the guest could not read back", () => {
  const storage = {
    capacity: 512,
    read: (_offset: number, target: Uint8Array) => target.byteLength,
  };
  assert.throws(() => blockDevice(storage, { serial: "x".repeat(21) }));
  assert.throws(() => blockDevice(storage, { serial: "caf\u00e9" }));
  assert.throws(() => blockDevice(storage, { serial: "a\0b" }));
});

test("console input is held until the guest opens its port", async () => {
  const console_memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  let input_controller!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      input_controller = controller;
    },
  });
  const output: string[] = [];
  const device = consoleDevice(
    input,
    new WritableStream({
      write(chunk) {
        output.push(new TextDecoder().decode(chunk));
      },
    }),
  );
  const delivered = Promise.withResolvers<void>();
  const imports = attach_devices({
    memory: console_memory,
    devices: [device],
    trigger_irq() {
      delivered.resolve();
    },
    on_error(error) {
      throw error;
    },
  });

  // A packed vring with one receive descriptor (at 64, length 4) that is not
  // yet available: the guest console port is not open.
  const descriptor = new DataView(console_memory.buffer);
  descriptor.setBigUint64(0, 64n, true);
  descriptor.setUint32(8, 4, true);
  descriptor.setUint16(12, 0, true);
  descriptor.setUint16(14, 0, true);
  imports.enable_vring(0, 0, 1, 0, 1);
  imports.notify(0, 0);

  // The host writes "hi" before the guest opens /dev/hvc0, and the input
  // handler runs while the descriptor is still unavailable.
  input_controller.enqueue(new TextEncoder().encode("hi"));
  await Promise.resolve();

  // Linux resets the device while probing it. The old descriptor must be
  // discarded, while input queued by the host survives for the replacement
  // queue that represents the opened console port.
  imports.reset(0, 0);
  imports.disable_vring(0, 0);
  const replacement_ring = 128;
  const replacement = new DataView(console_memory.buffer, replacement_ring, 16);
  replacement.setBigUint64(0, 256n, true);
  replacement.setUint32(8, 4, true);
  replacement.setUint16(12, 0, true);
  replacement.setUint16(14, (1 << 7) | (1 << 1), true);
  imports.enable_vring(0, 0, 1, replacement_ring, 1);
  imports.notify(0, 0);
  assert.deepEqual(
    [...new Uint8Array(console_memory.buffer, 256, 2)],
    [0, 0],
    "input remains queued until the guest console can consume it",
  );

  const output_ring = 384;
  const output_address = 512;
  new Uint8Array(console_memory.buffer, output_address, 5).set(new TextEncoder().encode("ready"));
  const output_descriptor = new DataView(console_memory.buffer, output_ring, 16);
  output_descriptor.setBigUint64(0, BigInt(output_address), true);
  output_descriptor.setUint32(8, 5, true);
  output_descriptor.setUint16(12, 0, true);
  output_descriptor.setUint16(14, 1 << 7);
  imports.enable_vring(0, 1, 1, output_ring, 2);
  imports.notify(0, 1);
  const undelivered = new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.race([delivered.promise, undelivered]);

  assert.deepEqual([...new Uint8Array(console_memory.buffer, 64, 2)], [0, 0]);
  const buffer = new Uint8Array(console_memory.buffer, 256, 4);
  assert.deepEqual(
    [...buffer.slice(0, 2)],
    [0x68, 0x69],
    "input must be held until the console port opens",
  );
  input_controller.close();
  await close_device(device);
});

test("virtio-vsock drops guest buffers and connections on reset", async () => {
  const device = vsockDevice();
  const vsock_memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const imports = attach_devices({
    memory: vsock_memory,
    devices: [device],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const descriptor = new DataView(vsock_memory.buffer, 0, 16);
  descriptor.setBigUint64(0, 64n, true);
  descriptor.setUint32(8, 64, true);
  descriptor.setUint16(12, 0, true);
  descriptor.setUint16(14, (1 << 7) | (1 << 1), true);
  imports.enable_vring(0, 0, 1, 0, 1);
  imports.notify(0, 0);
  imports.reset(0, 0);

  const connecting = device.connect(1024, { timeoutMs: 5000 });
  await Promise.resolve();
  assert.deepEqual([...new Uint8Array(vsock_memory.buffer, 64, 64)], Array(64).fill(0));
  imports.reset(0, 0);
  await assert.rejects(connecting, /vsock device reset while connecting/);
  await close_device(device);
});

test("virtio reset invalidates stale chains and pending notifications", async () => {
  const reset_memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const work = Promise.withResolvers<void>();
  let notifications = 0;
  let resets = 0;
  let interrupts = 0;
  let complete_stale_chain!: () => void;
  const device = new TestDevice({
    queues: [
      async (queue) => {
        notifications += 1;
        const [chain] = queue;
        assert(chain);
        if (notifications === 1) {
          const [buffer] = chain;
          assert(buffer?.writable);
          complete_stale_chain = () => {
            buffer.array[0] = 0xaa;
            chain.release(1);
          };
          await work.promise;
        } else {
          chain.release(1);
        }
      },
    ],
    reset() {
      resets += 1;
    },
  });
  const imports = attach_devices({
    memory: reset_memory,
    devices: [device.handle],
    trigger_irq() {
      interrupts += 1;
    },
    on_error(error) {
      throw error;
    },
  });
  const queue_descriptor = (ring: number, address: number) => {
    const descriptor = new DataView(reset_memory.buffer, ring, 16);
    descriptor.setBigUint64(0, BigInt(address), true);
    descriptor.setUint32(8, 1, true);
    descriptor.setUint16(12, 0, true);
    descriptor.setUint16(14, (1 << 7) | (1 << 1), true);
    return descriptor;
  };

  const stale_descriptor = queue_descriptor(0, 64);
  imports.enable_vring(0, 0, 1, 0, 1);
  imports.notify(0, 0);
  imports.notify(0, 0);
  assert.equal(notifications, 1);

  imports.reset(0, 0);
  assert.equal(resets, 1);
  // Linux deletes each queue after resetting the device. This must remain
  // harmless even though reset already invalidated and detached the queue.
  imports.disable_vring(0, 0);
  complete_stale_chain();
  await Promise.resolve();
  assert.equal(new Uint8Array(reset_memory.buffer, 64, 1)[0], 0);
  assert.equal(stale_descriptor.getUint32(8, true), 1);
  assert.equal(stale_descriptor.getUint16(14, true), (1 << 7) | (1 << 1));
  assert.equal(interrupts, 0);

  work.resolve();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(notifications, 1, "reset discarded the coalesced old kick");

  const restored_descriptor = queue_descriptor(128, 192);
  imports.enable_vring(0, 0, 1, 128, 2);
  imports.notify(0, 0);
  for (let i = 0; i < 10; i++) {
    if (restored_descriptor.getUint16(14, true) & (1 << 15)) break;
    await Promise.resolve();
  }
  assert.equal(notifications, 2);
  assert.equal(restored_descriptor.getUint32(8, true), 1);
  assert.notEqual(restored_descriptor.getUint16(14, true) & (1 << 15), 0);
  await Promise.resolve();
  assert.equal(interrupts, 1);
});

test("a remote virtio worker owns chains but the main thread publishes completions", async () => {
  const remote_memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const first_chain = Promise.withResolvers<{
    array: Uint8Array;
    release(written: number): void;
  }>();
  const stale_chain = Promise.withResolvers<{
    array: Uint8Array;
    release(written: number): void;
  }>();
  let notifications = 0;
  let resets = 0;
  let closes = 0;
  const served = new TestDevice({
    id: 2,
    config: Uint8Array.of(7),
    queues: [
      (queue) => {
        const [chain] = queue;
        assert(chain);
        const [buffer] = chain;
        assert(buffer?.writable);
        notifications += 1;
        (notifications === 1 ? first_chain : stale_chain).resolve({
          array: buffer.array,
          release: (written) => chain.release(written),
        });
      },
    ],
    reset() {
      resets += 1;
    },
    close() {
      closes += 1;
    },
  });
  const channel = new MessageChannel();
  serveDevice(channel.port1, served.handle);
  const device = await workerDevice(channel.port2);
  const interrupts: number[] = [];
  const errors: unknown[] = [];
  const imports = attach_devices({
    memory: remote_memory,
    devices: [device],
    trigger_irq: (irq) => interrupts.push(irq),
    on_error: (error) => errors.push(error),
  });
  const queue_descriptor = (ring: number, address: number) => {
    const descriptor = new DataView(remote_memory.buffer, ring, 16);
    descriptor.setBigUint64(0, BigInt(address), true);
    descriptor.setUint32(8, 1, true);
    descriptor.setUint16(12, 0, true);
    descriptor.setUint16(14, (1 << 7) | (1 << 1), true);
    return descriptor;
  };

  const config_address = 256;
  imports.setup(0, 3, config_address, 1);
  assert.equal(new Uint8Array(remote_memory.buffer, config_address, 1)[0], 7);

  const descriptor = queue_descriptor(0, 64);
  imports.enable_vring(0, 0, 1, 0, 5);
  imports.notify(0, 0);
  const first = await first_chain.promise;
  first.array[0] = 0xaa;
  first.release(1);
  await new Promise<void>((resolve) => {
    const check = () => (interrupts.length ? resolve() : setTimeout(check, 0));
    check();
  });
  assert.equal(new Uint8Array(remote_memory.buffer, 64, 1)[0], 0xaa);
  assert.equal(descriptor.getUint32(8, true), 1);
  assert.equal(descriptor.getUint16(14, true), (1 << 15) | (1 << 7) | (1 << 1));
  assert.deepEqual(interrupts, [5]);

  served.set_config(Uint8Array.of(9));
  await new Promise<void>((resolve) => {
    const check = () => (interrupts.includes(3) ? resolve() : setTimeout(check, 0));
    check();
  });
  assert.equal(new Uint8Array(remote_memory.buffer, config_address, 1)[0], 9);

  queue_descriptor(128, 192);
  imports.enable_vring(0, 0, 1, 128, 6);
  imports.notify(0, 0);
  const stale = await stale_chain.promise;
  imports.reset(0, 0);
  stale.array[0] = 0xbb;
  stale.release(1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(new Uint8Array(remote_memory.buffer, 192, 1)[0], 0);
  assert.deepEqual(interrupts, [5, 3]);
  assert.equal(resets, 1);
  assert.deepEqual(errors, []);

  await close_device(device);
  assert.equal(closes, 1);
  channel.port1.close();
  channel.port2.close();
});

test("an unattached remote virtio device can be closed", async () => {
  let closes = 0;
  const served = blockDevice({
    capacity: 512,
    read: (_offset, target) => target.byteLength,
    close() {
      closes += 1;
    },
  });
  const channel = new MessageChannel();
  serveDevice(channel.port1, served);
  const device = await workerDevice(channel.port2);

  await close_device(device);
  assert.equal(closes, 1);
  channel.port1.close();
  channel.port2.close();
});

test("a worker-device failure after ready is observed before attachment", async () => {
  const served = blockDevice({
    capacity: 512,
    read: (_offset, target) => target.byteLength,
  });
  const channel = new MessageChannel();
  serveDevice(channel.port1, served);
  const device = await workerDevice(channel.port2);

  channel.port1.postMessage({
    type: "error",
    error: { name: "Error", message: "worker failed after ready" },
  });
  await assert.rejects(device.closed, /worker failed after ready/);
  await assert.rejects(close_device(device), /worker failed after ready/);

  await close_device(served);
  channel.port1.close();
  channel.port2.close();
});

test("serveDeviceError rejects workerDevice with the error's name and message", async () => {
  const channel = new MessageChannel();
  serveDeviceError(
    channel.port1,
    new DOMException("the file is open in another tab", "NoModificationAllowedError"),
  );
  await assert.rejects(workerDevice(channel.port2), {
    name: "NoModificationAllowedError",
    message: "the file is open in another tab",
  });
  channel.port1.close();
  channel.port2.close();
});

test("workerDevice accepts a Node Worker endpoint", async () => {
  const worker = new Worker(
    `
      const { parentPort } = require("node:worker_threads");
      parentPort.postMessage({
        type: "ready",
        device_id: 4,
        features: 0n,
        config: new Uint8Array(),
        queues: 0,
      });
      parentPort.on("message", (message) => {
        if (message.type === "close") parentPort.postMessage({ type: "closed" });
      });
    `,
    { eval: true },
  );
  try {
    const device = await workerDevice(worker);
    await close_device(device);
  } finally {
    await worker.terminate();
  }
});

test("virtio close drains active queue work before one-time cleanup", async () => {
  const work = Promise.withResolvers<void>();
  let notifications = 0;
  let closes = 0;
  const device = new TestDevice({
    queues: [
      async () => {
        notifications += 1;
        await work.promise;
      },
    ],
    close() {
      closes += 1;
    },
  });
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const imports = attach_devices({
    memory,
    devices: [device.handle],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const descriptor = new DataView(memory.buffer);
  descriptor.setBigUint64(0, 64n, true);
  descriptor.setUint32(8, 1, true);
  descriptor.setUint16(12, 0, true);
  descriptor.setUint16(14, 1 << 7, true);
  imports.enable_vring(0, 0, 1, 0, 1);
  imports.notify(0, 0);

  assert.equal(notifications, 1);
  const closing = close_device(device.handle);
  assert.strictEqual(close_device(device.handle), closing);
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(closes, 0);

  work.resolve();
  await closing;
  assert.equal(closes, 1);
  imports.notify(0, 0);
  await Promise.resolve();
  assert.equal(notifications, 1);
});

test("virtio close reports driver cleanup failure exactly once", async () => {
  const error = new Error("cleanup failed");
  let closes = 0;
  const device = new TestDevice({
    close() {
      closes += 1;
      throw error;
    },
  });

  const closing = close_device(device.handle);
  await assert.rejects(closing, (thrown) => thrown === error);
  await assert.rejects(close_device(device.handle), (thrown) => thrown === error);
  assert.equal(closes, 1);
});

test("virtio tracks a handler before it can reentrantly close", async () => {
  const work = Promise.withResolvers<void>();
  let closes = 0;
  let device!: TestDevice;
  device = new TestDevice({
    queues: [
      () => {
        void device.shutdown();
        return work.promise;
      },
    ],
    close() {
      closes += 1;
    },
  });
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const imports = attach_devices({
    memory,
    devices: [device.handle],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const descriptor = new DataView(memory.buffer);
  descriptor.setBigUint64(0, 64n, true);
  descriptor.setUint32(8, 1, true);
  descriptor.setUint16(12, 0, true);
  descriptor.setUint16(14, 1 << 7, true);
  imports.enable_vring(0, 0, 1, 0, 1);
  imports.notify(0, 0);

  const closing = close_device(device.handle);
  await Promise.resolve();
  assert.equal(closes, 0);
  work.resolve();
  await closing;
  assert.equal(closes, 1);
});

test("virtio stop can unblock a handler before final cleanup", async () => {
  const work = Promise.withResolvers<void>();
  const events: string[] = [];
  const device = new TestDevice({
    queues: [
      async () => {
        events.push("notify");
        await work.promise;
      },
    ],
    stop() {
      events.push("stop");
      work.resolve();
    },
    close() {
      events.push("close");
    },
  });
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const imports = attach_devices({
    memory,
    devices: [device.handle],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const descriptor = new DataView(memory.buffer);
  descriptor.setBigUint64(0, 64n, true);
  descriptor.setUint32(8, 1, true);
  descriptor.setUint16(12, 0, true);
  descriptor.setUint16(14, 1 << 7, true);
  imports.enable_vring(0, 0, 1, 0, 1);
  imports.notify(0, 0);

  await close_device(device.handle);
  assert.deepEqual(events, ["notify", "stop", "close"]);
});

function post_receive_buffers(memory: WebAssembly.Memory, ring: number, count: number) {
  for (let i = 0; i < count; i++) {
    const descriptor = new DataView(memory.buffer, ring + i * 16, 16);
    descriptor.setBigUint64(0, BigInt(0x1000 + i * 128), true);
    descriptor.setUint32(8, 128, true);
    descriptor.setUint16(12, i, true);
    descriptor.setUint16(14, (1 << 7) | (1 << 1), true);
  }
}

const settled_soon = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
  ]);

test("virtio-net holds unicast senders until the guest takes their frames", async () => {
  const network = ethernetNetwork();
  const device = ethernetDevice(network, { macAddress: [0x02, 0, 0, 0, 0, 1] });
  const sender = network.addPort(() => {});
  const net_memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const imports = attach_devices({
    memory: net_memory,
    devices: [device],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const frame = (n: number) => Uint8Array.from([2, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 2, 0x08, 0, n]);

  // The guest transmits once, so the switch learns its MAC and frames to it
  // are unicast rather than flooded.
  const tx_ring = 0x800;
  const announcement = new Uint8Array(net_memory.buffer, 0x900, 12 + 14);
  announcement.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 2, 0, 0, 0, 0, 1, 8, 0], 12);
  const tx = new DataView(net_memory.buffer, tx_ring, 16);
  tx.setBigUint64(0, 0x900n, true);
  tx.setUint32(8, announcement.byteLength, true);
  tx.setUint16(14, 1 << 7, true);
  imports.enable_vring(0, 1, 1, tx_ring, 2);
  imports.notify(0, 1);
  await new Promise((resolve) => setTimeout(resolve, 1));

  const ring = 0;
  post_receive_buffers(net_memory, ring, 32);
  imports.enable_vring(0, 0, 32, ring, 1);

  const sends: Promise<void>[] = [];
  let index = 0;
  for (; index < 64; index++) {
    const send = sender.send(frame(index));
    sends.push(send);
    if (!(await settled_soon(send))) break;
  }
  // Without posted buffers, a bounded backlog is accepted and then the
  // sender is held instead of frames being dropped.
  assert.ok(index > 0 && index < 64, `sender was held after ${index} frames`);

  imports.notify(0, 0);
  assert.equal(await settled_soon(sends[index]!), true);
  for (let i = 0; i <= index; i++) {
    const payload = new Uint8Array(net_memory.buffer, 0x1000 + i * 128 + 12 + 14, 1)[0];
    assert.equal(payload, i, `frame ${i} delivered in order`);
  }

  sender.close();
  await close_device(device);
  network.close();
});

test("a stalled recipient does not hold a NIC through reset or close", async () => {
  const network = ethernetNetwork();
  const device = ethernetDevice(network, { macAddress: [2, 0, 0, 0, 0, 1] });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const imports = attach_devices({
    memory,
    devices: [device],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const broadcast_from = (last: number) =>
    Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 2, 0, 0, 0, 0, last, 8, 0]);
  // Each port transmits once, so the switch learns it and unicasts to it.
  const stalled = network.addPort(() => new Promise<void>(() => {}));
  await stalled.send(broadcast_from(0x0a));
  const delivered: number[] = [];
  const recorder = network.addPort((frame) => {
    delivered.push(frame[14]!);
  });
  await recorder.send(broadcast_from(0x0b));

  const transmit = (ring: number, buffer: number, to: number, payload: number) => {
    const packet = new Uint8Array(memory.buffer, buffer, 12 + 15);
    packet.set([2, 0, 0, 0, 0, to, 2, 0, 0, 0, 0, 1, 8, 0, payload], 12);
    const descriptor = new DataView(memory.buffer, ring, 16);
    descriptor.setBigUint64(0, BigInt(buffer), true);
    descriptor.setUint32(8, packet.byteLength, true);
    descriptor.setUint16(14, 1 << 7, true);
    imports.enable_vring(0, 1, 1, ring, 2);
    imports.notify(0, 1);
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  transmit(0x800, 0x900, 0x0a, 1);
  await tick();

  // The old transmit waits on the stalled port; the replacement queue must
  // not wait behind it.
  imports.reset(0, 0);
  transmit(0xa00, 0xb00, 0x0b, 2);
  for (let i = 0; i < 100 && delivered.length === 0; i++) await tick();
  assert.deepEqual(delivered, [2]);

  transmit(0xc00, 0xd00, 0x0a, 3);
  await tick();
  assert.equal(await settled_soon(close_device(device)), true);
  stalled.close();
  recorder.close();
  network.close();
});

test("virtio-net floods without waiting for a stalled guest", async () => {
  const network = ethernetNetwork();
  const device = ethernetDevice(network);
  const sender = network.addPort(() => {});
  let received = 0;
  network.addPort(() => {
    received += 1;
  });
  const broadcast = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 2, 0, 0, 0, 0, 2, 8, 0]);

  for (let i = 0; i < 300; i++) {
    assert.equal(await settled_soon(sender.send(broadcast)), true);
  }
  assert.equal(received, 300);

  sender.close();
  await close_device(device);
  network.close();
});

test("console input is read only as the guest consumes it", async () => {
  const console_memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  let pulls = 0;
  const input = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode(`${pulls}`));
      },
    },
    { highWaterMark: 0 },
  );
  const device = consoleDevice(input, new WritableStream());
  const imports = attach_devices({
    memory: console_memory,
    devices: [device],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const wait = async (condition: () => boolean) => {
    for (let i = 0; i < 50 && !condition(); i++) await new Promise((r) => setTimeout(r, 1));
  };

  // Open the port with an empty transmit, then post two receive buffers.
  imports.enable_vring(0, 1, 1, 512, 2);
  new DataView(console_memory.buffer, 512, 16).setUint16(14, 1 << 7, true);
  imports.notify(0, 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(pulls, 0, "no input is read before the guest posts a buffer");

  post_receive_buffers(console_memory, 0, 2);
  imports.enable_vring(0, 0, 4, 0, 1);
  imports.notify(0, 0);
  await wait(() => new Uint8Array(console_memory.buffer, 0x1000 + 128, 1)[0] !== 0);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(new Uint8Array(console_memory.buffer, 0x1000, 1)[0], 0x31);
  assert.equal(new Uint8Array(console_memory.buffer, 0x1000 + 128, 1)[0], 0x32);
  assert.ok(pulls <= 3, `input was pulled ${pulls} times for two buffers`);

  await close_device(device);
});

// Lays out block requests on a packed ring: each request is a readable
// header, its data descriptors, and a writable status byte.
function block_ring(memory: WebAssembly.Memory) {
  const available = 1 << 7;
  const next = 1;
  const writable = 1 << 1;
  let index = 0;
  let id = 0;
  let heap = 0x1000;
  const descriptor = (address: number, length: number, flags: number, chain_id: number) => {
    const view = new DataView(memory.buffer, index++ * 16, 16);
    view.setBigUint64(0, BigInt(address), true);
    view.setUint32(8, length, true);
    view.setUint16(12, chain_id, true);
    view.setUint16(14, available | flags, true);
  };
  return {
    request(type: number, sector: number, data: readonly { address?: number; length: number }[]) {
      const chain_id = id++;
      const header = heap;
      heap += 16;
      const view = new DataView(memory.buffer, header, 16);
      view.setUint32(0, type, true);
      view.setBigUint64(8, BigInt(sector), true);
      descriptor(header, 16, next, chain_id);
      const addresses = data.map(({ address, length }) => {
        const at = address ?? heap;
        if (address === undefined) heap += length;
        descriptor(at, length, next | (type === 0 ? writable : 0), chain_id);
        return at;
      });
      const status = heap++;
      new Uint8Array(memory.buffer, status, 1)[0] = 0xff;
      descriptor(status, 1, writable, chain_id);
      return { status: () => new Uint8Array(memory.buffer, status, 1)[0], addresses };
    },
  };
}

function block_machine(storage: Parameters<typeof blockDevice>[0]) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const device = blockDevice(storage);
  const imports = attach_devices({
    memory,
    devices: [device],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  return { memory, device, imports, ring: block_ring(memory) };
}

const turns = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("virtio block completes independent requests out of order", async () => {
  const slow = Promise.withResolvers<void>();
  const { memory, device, imports, ring } = block_machine({
    capacity: 4096,
    async read(offset, target) {
      if (offset === 0) await slow.promise;
      target.fill(offset === 0 ? 1 : 2);
      return target.byteLength;
    },
  });
  const first = ring.request(0, 0, [{ length: 512 }]);
  const second = ring.request(0, 1, [{ length: 512 }]);
  imports.enable_vring(0, 0, 16, 0, 1);
  imports.notify(0, 0);

  await turns();
  assert.equal(second.status(), 0, "the second request completes while the first is pending");
  assert.equal(new Uint8Array(memory.buffer, second.addresses[0]!, 1)[0], 2);
  assert.equal(first.status(), 0xff);

  slow.resolve();
  await turns();
  assert.equal(first.status(), 0);
  assert.equal(new Uint8Array(memory.buffer, first.addresses[0]!, 1)[0], 1);
  await close_device(device);
});

test("virtio block fails requests outside its sectors or segment limit", async () => {
  const calls: number[] = [];
  const { device, imports, ring } = block_machine({
    capacity: 4096 + 100,
    read(offset, target) {
      calls.push(offset);
      return target.byteLength;
    },
  });
  // The trailing partial sector is not advertised, so it is out of range too.
  const straddling = ring.request(0, 7, [{ length: 1024 }]);
  const beyond = ring.request(0, 2 ** 60, [{ length: 512 }]);
  // SEG_MAX is 128; separate addresses keep the segments from merging.
  const segments = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ address: 0x8000 + i * 2, length: 1 }));
  // The ring is laid out below 0x1000, so 255 descriptors at most.
  const too_many = ring.request(0, 0, segments(129));
  const most = ring.request(0, 0, segments(114));
  const last = ring.request(0, 7, [{ length: 512 }]);
  imports.enable_vring(0, 0, 256, 0, 1);
  imports.notify(0, 0);
  await turns();

  assert.equal(straddling.status(), 1);
  assert.equal(beyond.status(), 1);
  assert.equal(too_many.status(), 1);
  assert.equal(most.status(), 0);
  assert.equal(last.status(), 0);
  assert.ok(
    calls.every((offset) => offset < 4096),
    "storage only sees advertised sectors",
  );
  await close_device(device);
});

test(
  "a block request failure that closes the device lets the close finish",
  { timeout: 5_000 },
  async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const device = blockDevice({
      capacity: 4096,
      read() {
        throw new Error("disk failed");
      },
    });
    // Like a machine, report the failure by shutting down and returning that.
    let closing: Promise<void> | undefined;
    const imports = attach_devices({
      memory,
      devices: [device],
      trigger_irq() {},
      on_error() {
        return (closing ??= close_device(device));
      },
    });
    block_ring(memory).request(0, 0, [{ length: 512 }]);
    imports.enable_vring(0, 0, 16, 0, 1);
    imports.notify(0, 0);
    for (let i = 0; i < 100 && !closing; i++) await turns(1);
    assert(closing, "the failure was reported");
    // The failure went to on_error; the close itself just has to finish.
    await closing;
  },
);

test("virtio block rejects storage it cannot address exactly", () => {
  assert.throws(() => blockDevice({ capacity: 2 ** 62, read: () => 0 }), /safe integer/);
});

test("virtio block flushes only after earlier writes complete", async () => {
  const write = Promise.withResolvers<void>();
  const events: string[] = [];
  const { device, imports, ring } = block_machine({
    capacity: 4096,
    read: (_offset, target) => target.byteLength,
    async write(_offset, data) {
      events.push("write started");
      await write.promise;
      events.push("write done");
      return data.byteLength;
    },
    flush() {
      events.push("flush");
    },
  });
  ring.request(1, 0, [{ length: 512 }]);
  const flush = ring.request(4, 0, []);
  imports.enable_vring(0, 0, 16, 0, 1);
  imports.notify(0, 0);

  await turns();
  assert.deepEqual(events, ["write started"]);
  assert.equal(flush.status(), 0xff);
  write.resolve();
  await turns();
  assert.deepEqual(events, ["write started", "write done", "flush"]);
  assert.equal(flush.status(), 0);
  await close_device(device);
});

test("virtio block hands storage guest memory in as few calls as it can", async () => {
  const calls: { kind: string; offset: number; length: number; guest: boolean }[] = [];
  const { memory, device, imports, ring } = block_machine({
    capacity: 8192,
    read(offset, target) {
      calls.push({
        kind: "read",
        offset,
        length: target.byteLength,
        guest: target.buffer === memory.buffer,
      });
      for (let i = 0; i < target.byteLength; i++) target[i] = (offset + i) & 0xff;
      return target.byteLength;
    },
    write(offset, data) {
      calls.push({
        kind: "write",
        offset,
        length: data.byteLength,
        guest: data.buffer === memory.buffer,
      });
      return data.byteLength;
    },
  });
  // Segments adjacent in guest memory merge into one call; split ones take
  // one call each when storage has no vectored method.
  const read = ring.request(0, 1, [{ length: 512 }, { length: 512 }]);
  ring.request(1, 4, [
    { address: 0x4000, length: 512 },
    { address: 0x4200, length: 512 },
  ]);
  ring.request(1, 8, [
    { address: 0x5000, length: 512 },
    { address: 0x6000, length: 512 },
  ]);
  imports.enable_vring(0, 0, 32, 0, 1);
  imports.notify(0, 0);
  await turns();

  assert.deepEqual(calls, [
    { kind: "read", offset: 512, length: 1024, guest: true },
    { kind: "write", offset: 2048, length: 1024, guest: true },
    { kind: "write", offset: 4096, length: 512, guest: true },
    { kind: "write", offset: 4608, length: 512, guest: true },
  ]);
  assert.equal(read.status(), 0);
  assert.equal(new Uint8Array(memory.buffer, read.addresses[1]!, 1)[0], (512 + 512) & 0xff);
  await close_device(device);
});

test("virtio block makes one vectored call for a split request", async () => {
  const calls: string[] = [];
  const { device, imports, ring } = block_machine({
    capacity: 8192,
    read: (_offset, target) => target.byteLength,
    readv(offset, targets) {
      calls.push(`readv ${offset} ${targets.map((target) => target.byteLength)}`);
      return targets.reduce((total, target) => total + target.byteLength, 0);
    },
    write: (_offset, data) => data.byteLength,
    writev(offset, sources) {
      calls.push(`writev ${offset} ${sources.map((source) => source.byteLength)}`);
      return sources.reduce((total, source) => total + source.byteLength, 0);
    },
  });
  const read = ring.request(0, 0, [
    { address: 0x5000, length: 512 },
    { address: 0x6000, length: 1024 },
  ]);
  const write = ring.request(1, 4, [
    { address: 0x7000, length: 512 },
    { address: 0x7800, length: 512 },
  ]);
  imports.enable_vring(0, 0, 32, 0, 1);
  imports.notify(0, 0);
  await turns();

  assert.deepEqual(calls, ["readv 0 512,1024", "writev 2048 512,512"]);
  assert.equal(read.status(), 0);
  assert.equal(write.status(), 0);
  await close_device(device);
});

test("virtio block close waits for requests in flight", async () => {
  const read = Promise.withResolvers<void>();
  const events: string[] = [];
  const { device, imports, ring } = block_machine({
    capacity: 4096,
    async read(_offset, target) {
      await read.promise;
      events.push("read");
      return target.byteLength;
    },
    close() {
      events.push("close");
    },
  });
  ring.request(0, 0, [{ length: 512 }]);
  imports.enable_vring(0, 0, 16, 0, 1);
  imports.notify(0, 0);
  const closing = close_device(device);
  await turns();
  assert.deepEqual(events, []);
  read.resolve();
  await closing;
  assert.deepEqual(events, ["read", "close"]);
});

test(
  "a remote virtio block device reads a multi-descriptor request",
  { timeout: 5_000 },
  async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const channel = new MessageChannel();
    serveDevice(
      channel.port1,
      blockDevice({
        capacity: 4096,
        read(offset, target) {
          for (let i = 0; i < target.byteLength; i++) target[i] = (offset + i) & 0xff;
          return target.byteLength;
        },
      }),
    );
    const device = await workerDevice(channel.port2);
    const interrupted = Promise.withResolvers<void>();
    const imports = attach_devices({
      memory,
      devices: [device],
      trigger_irq: () => interrupted.resolve(),
      on_error: (error) => interrupted.reject(error),
    });
    const ring = block_ring(memory);
    const read = ring.request(0, 1, [{ length: 512 }, { length: 512 }]);
    imports.enable_vring(0, 0, 16, 0, 1);
    imports.notify(0, 0);
    await interrupted.promise;

    assert.equal(read.status(), 0);
    assert.equal(new Uint8Array(memory.buffer, read.addresses[0]!, 1)[0], 512 & 0xff);
    assert.equal(new Uint8Array(memory.buffer, read.addresses[1]!, 1)[0], 1024 & 0xff);
    await close_device(device);
    channel.port1.close();
    channel.port2.close();
  },
);

test("a device with views works on guest memory in place", async () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const seen = Promise.withResolvers<{ readable: Uint8Array; writable: Uint8Array }>();
  const device = new TestDevice({
    views: true,
    queues: [
      (queue) => {
        const [chain] = queue;
        assert(chain);
        const [readable, writable] = chain;
        assert(readable && writable);
        seen.resolve({ readable: readable.array, writable: writable.array });
      },
    ],
  });
  const imports = attach_devices({
    memory,
    devices: [device.handle],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const descriptor = (index: number, address: number, flags: number) => {
    const view = new DataView(memory.buffer, index * 16, 16);
    view.setBigUint64(0, BigInt(address), true);
    view.setUint32(8, 4, true);
    view.setUint16(14, (1 << 7) | flags, true);
  };
  descriptor(0, 0x100, 1);
  descriptor(1, 0x200, 1 << 1);
  imports.enable_vring(0, 0, 4, 0, 1);
  imports.notify(0, 0);

  const { readable, writable } = await seen.promise;
  assert.equal(readable.buffer, memory.buffer);
  assert.equal(readable.byteOffset, 0x100);
  assert.equal(writable.buffer, memory.buffer);
  assert.equal(writable.byteOffset, 0x200);
  await close_device(device.handle);
});

test("a copied chain writes back only the bytes the device reports", async () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const seen = Promise.withResolvers<Uint8Array[]>();
  const device = new TestDevice({
    queues: [
      (queue) => {
        const [chain] = queue;
        assert(chain);
        const [readable, first, second] = chain;
        assert(readable && !readable.writable && first?.writable && second?.writable);
        assert.deepEqual([...readable.array], [1, 2, 3, 4]);
        // The guest's contents of writable buffers are not copied in.
        seen.resolve([first.array.slice(), second.array.slice()]);
        first.array.fill(0x11);
        second.array.fill(0x22);
        chain.release(6);
      },
    ],
  });
  const imports = attach_devices({
    memory,
    devices: [device.handle],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const descriptor = (index: number, address: number, flags: number) => {
    const view = new DataView(memory.buffer, index * 16, 16);
    view.setBigUint64(0, BigInt(address), true);
    view.setUint32(8, 4, true);
    view.setUint16(14, (1 << 7) | flags, true);
  };
  const guest = new Uint8Array(memory.buffer);
  guest.set([1, 2, 3, 4], 0x100);
  guest.fill(0xee, 0x200, 0x204);
  guest.fill(0xee, 0x300, 0x304);
  descriptor(0, 0x100, 1);
  descriptor(1, 0x200, 1 | (1 << 1));
  descriptor(2, 0x300, 1 << 1);
  imports.enable_vring(0, 0, 4, 0, 1);
  imports.notify(0, 0);

  const [first, second] = await seen.promise;
  assert.deepEqual([...first!], [0, 0, 0, 0]);
  assert.deepEqual([...second!], [0, 0, 0, 0]);
  assert.deepEqual([...guest.subarray(0x200, 0x204)], [0x11, 0x11, 0x11, 0x11]);
  assert.deepEqual([...guest.subarray(0x300, 0x304)], [0x22, 0x22, 0xee, 0xee]);
  assert.equal(new DataView(memory.buffer).getUint32(8, true), 6);
  await close_device(device.handle);
});

test("a virtqueue rejects an indirect table longer than the queue", async () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  let kicked = false;
  const failure = Promise.withResolvers<unknown>();
  const device = new TestDevice({
    queues: [
      (queue) => {
        kicked = true;
        for (const _chain of queue);
      },
    ],
  });
  const imports = attach_devices({
    memory,
    devices: [device.handle],
    trigger_irq() {},
    on_error: failure.resolve,
  });
  // One ring entry pointing at a two-entry indirect table.
  const descriptor = new DataView(memory.buffer, 0, 16);
  descriptor.setBigUint64(0, 0x100n, true);
  descriptor.setUint32(8, 2 * 16, true);
  descriptor.setUint16(14, (1 << 7) | (1 << 2), true);
  imports.enable_vring(0, 0, 1, 0, 1);
  imports.notify(0, 0);
  assert.match(String(await failure.promise), /malformed indirect buffer/);
  assert(kicked);
  await close_device(device.handle).catch(() => {});
});

// A reset of a device that works on guest memory in place must not let the
// guest reuse that memory until in-flight storage calls have finished with it,
// even if the machine starts closing while the guest waits.
async function reset_during_slow_read(
  attach: (storage: Parameters<typeof blockDevice>[0]) => Promise<{
    memory: WebAssembly.Memory;
    imports: ReturnType<typeof attach_devices>;
    close(): Promise<void>;
  }>,
  { close_while_waiting = false } = {},
) {
  const slow = Promise.withResolvers<void>();
  let finished_with_memory = false;
  const { memory, imports, close } = await attach({
    capacity: 4096,
    async read(_offset, target) {
      await slow.promise;
      target.fill(0xaa);
      finished_with_memory = true;
      return target.byteLength;
    },
  });
  // A failed assertion must not leave the read, and so the close, hanging.
  try {
    const ring = block_ring(memory);
    const read = ring.request(0, 0, [{ length: 512 }]);
    imports.enable_vring(0, 0, 16, 0, 1);
    imports.notify(0, 0);
    await turns();

    const done = 0x8000;
    const done_word = () => new Int32Array(memory.buffer, done, 1)[0];
    imports.reset(0, done);
    imports.disable_vring(0, 0);
    const closing = close_while_waiting ? close() : undefined;
    await turns();
    assert.equal(done_word(), 0, "reset waits for the read that holds guest memory");

    slow.resolve();
    for (let i = 0; i < 100 && done_word() === 0; i++) await turns(1);
    assert.equal(done_word(), 1);
    assert.equal(finished_with_memory, true, "storage finished before the reset was acknowledged");

    // The guest now reuses the buffer and the status byte. Nothing may write
    // to them afterwards, and the stale completion is never published.
    const target = new Uint8Array(memory.buffer, read.addresses[0]!, 512);
    target.fill(0x55);
    const status = new Uint8Array(memory.buffer, read.addresses[0]! + 512, 1);
    status[0] = 0x55;
    await turns();
    assert.ok(target.every((byte) => byte === 0x55));
    assert.equal(status[0], 0x55);
    assert.equal(new DataView(memory.buffer, 0, 16).getUint16(14, true) & (1 << 15), 0);
    await (closing ?? close());
  } finally {
    slow.resolve();
  }
}

async function local_block(storage: Parameters<typeof blockDevice>[0]) {
  const { memory, device, imports } = block_machine(storage);
  return { memory, imports, close: () => close_device(device) };
}

async function remote_block(storage: Parameters<typeof blockDevice>[0]) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const channel = new MessageChannel();
  serveDevice(channel.port1, blockDevice(storage));
  const device = await workerDevice(channel.port2);
  const imports = attach_devices({
    memory,
    devices: [device],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  return {
    memory,
    imports,
    async close() {
      await close_device(device);
      channel.port1.close();
      channel.port2.close();
    },
  };
}

test("a block reset waits for in-flight storage to finish with guest memory", async () => {
  await reset_during_slow_read(local_block);
});

test("a block reset still waits for storage when the device closes meanwhile", async () => {
  await reset_during_slow_read(local_block, { close_while_waiting: true });
});

test(
  "a remote block reset waits for the worker to finish with guest memory",
  { timeout: 5_000 },
  async () => {
    await reset_during_slow_read(remote_block);
  },
);

test(
  "a remote block reset still waits for the worker when the device closes meanwhile",
  { timeout: 5_000 },
  async () => {
    await reset_during_slow_read(remote_block, { close_while_waiting: true });
  },
);

// A virtio-fs request queue driven by hand: requests and replies are raw FUSE.
function fs_ring(memory: WebAssembly.Memory) {
  const view = new DataView(memory.buffer);
  const AVAIL = 1 << 7;
  const USED = 1 << 15;
  const NEXT = 1 << 0;
  const WRITE = 1 << 1;
  const descriptor = (index: number, address: number, length: number, flags: number) => {
    view.setBigUint64(index * 16, BigInt(address), true);
    view.setUint32(index * 16 + 8, length, true);
    view.setUint16(index * 16 + 12, index, true);
    view.setUint16(index * 16 + 14, flags | AVAIL, true);
  };
  const header = (address: number, length: number, opcode: number, unique: number) => {
    view.setUint32(address, length, true);
    view.setUint32(address + 4, opcode, true);
    view.setBigUint64(address + 8, BigInt(unique), true);
    view.setBigUint64(address + 16, 1n, true);
  };
  return {
    view,
    NEXT,
    WRITE,
    descriptor,
    used: (index: number) => (view.getUint16(index * 16 + 14, true) & USED) !== 0,
    async completed(index: number) {
      for (let i = 0; i < 1000 && !this.used(index); i++) await turns(1);
      assert(this.used(index), `descriptor ${index} was not used`);
    },
    /** OPENs the root into descriptors 0 and 1, returning the file handle. */
    open(notify: () => void) {
      header(1024, 48, 14, 1);
      descriptor(0, 1024, 48, NEXT);
      descriptor(1, 2048, 32, WRITE);
      notify();
      return this.completed(0).then(() => {
        assert.equal(view.getInt32(2048 + 4, true), 0);
        return view.getBigUint64(2048 + 16, true);
      });
    },
    /**
     * READs `length` bytes into descriptors 2-4: a 16-byte reply header and
     * 8 bytes of data in one writable buffer, the rest in another.
     */
    read(fh: bigint, length: number) {
      header(1100, 80, 15, 2);
      view.setBigUint64(1140, fh, true);
      view.setBigUint64(1148, 0n, true);
      view.setUint32(1156, length, true);
      descriptor(2, 1100, 80, NEXT);
      descriptor(3, 3072, 24, NEXT | WRITE);
      descriptor(4, 3200, 64, WRITE);
    },
  };
}

function readable_file(read: (offset: number, length: number) => Promise<Uint8Array> | Uint8Array) {
  return fileSystemDevice(
    {
      root: {},
      lookup: () => undefined,
      getattr: () => ({ mode: 0o100644, size: 100n }),
      open: () => "handle",
      read: (_node, _handle, offset, length) => read(Number(offset), length),
    },
    { tag: "test", cache: false },
  );
}

async function remote(served: Device) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const channel = new MessageChannel();
  serveDevice(channel.port1, served);
  const device = await workerDevice(channel.port2);
  const interrupts: number[] = [];
  const errors: unknown[] = [];
  const imports = attach_devices({
    memory,
    devices: [device],
    trigger_irq: (irq) => interrupts.push(irq),
    on_error: (error) => errors.push(error),
  });
  return {
    memory,
    imports,
    interrupts,
    errors,
    async close() {
      await close_device(device);
      channel.port1.close();
      channel.port2.close();
    },
  };
}

async function local(device: Device) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const interrupts: number[] = [];
  const errors: unknown[] = [];
  const imports = attach_devices({
    memory,
    devices: [device],
    trigger_irq: (irq) => interrupts.push(irq),
    on_error: (error) => errors.push(error),
  });
  return { memory, imports, interrupts, errors, close: () => close_device(device) };
}

test(
  "a remote virtio-fs read split across descriptors reaches guest memory",
  { timeout: 5_000 },
  async () => {
    const contents = Uint8Array.from({ length: 100 }, (_, index) => index);
    // The read returns a view of the filesystem's own storage, which the
    // remote transport must not detach.
    const { memory, imports, interrupts, errors, close } = await remote(
      readable_file((offset, length) => contents.subarray(offset, offset + length)),
    );
    const ring = fs_ring(memory);
    imports.enable_vring(0, 1, 8, 0, 4);
    const fh = await ring.open(() => imports.notify(0, 1));

    ring.read(fh, 40);
    imports.notify(0, 1);
    await ring.completed(2);

    const { view } = ring;
    assert.equal(view.getUint32(3072, true), 56);
    assert.equal(view.getInt32(3072 + 4, true), 0);
    assert.equal(view.getBigUint64(3072 + 8, true), 2n);
    assert.equal(view.getUint32(2 * 16 + 8, true), 56);
    assert.deepEqual(
      [...new Uint8Array(memory.buffer, 3088, 8), ...new Uint8Array(memory.buffer, 3200, 32)],
      [...contents.subarray(0, 40)],
    );
    assert.equal(contents.byteLength, 100, "the filesystem's storage was not detached");
    for (let i = 0; i < 100 && interrupts.length < 2; i++) await turns(1);
    assert.deepEqual(interrupts, [4, 4]);
    assert.deepEqual(errors, []);
    await close();
  },
);

// virtio-fs writes replies into guest memory in place, so a guest reset must
// wait for a request in flight, and nothing may write the reply afterwards.
async function fs_reset_during_slow_read(attach: typeof local) {
  const slow = Promise.withResolvers<void>();
  let finished = false;
  const { memory, imports, errors, close } = await attach(
    readable_file(async (_offset, length) => {
      await slow.promise;
      finished = true;
      return new Uint8Array(length).fill(0xaa);
    }),
  );
  try {
    const ring = fs_ring(memory);
    imports.enable_vring(0, 1, 8, 0, 4);
    const fh = await ring.open(() => imports.notify(0, 1));
    ring.read(fh, 40);
    imports.notify(0, 1);
    await turns();

    const done = 0x8000;
    const done_word = () => new Int32Array(memory.buffer, done, 1)[0];
    imports.reset(0, done);
    imports.disable_vring(0, 1);
    await turns();
    assert.equal(done_word(), 0, "reset waits for the request that holds guest memory");

    slow.resolve();
    for (let i = 0; i < 100 && done_word() === 0; i++) await turns(1);
    assert.equal(done_word(), 1);
    assert.equal(finished, true, "the filesystem finished before the reset was acknowledged");

    // The guest now reuses the reply buffers; nothing may write to them, and
    // the stale completion is never published.
    const reply = new Uint8Array(memory.buffer, 3072, 24);
    reply.fill(0x55);
    await turns();
    assert.ok(reply.every((byte) => byte === 0x55));
    assert.equal(ring.used(2), false);
    assert.deepEqual(errors, []);
  } finally {
    slow.resolve();
    await close();
  }
}

test("a virtio-fs reset waits for the request in flight", async () => {
  await fs_reset_during_slow_read(local);
});

test(
  "a remote virtio-fs reset waits for the worker's request in flight",
  { timeout: 5_000 },
  async () => {
    await fs_reset_during_slow_read(remote);
  },
);
