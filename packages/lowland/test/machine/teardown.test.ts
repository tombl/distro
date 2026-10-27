// SPDX-License-Identifier: MIT

// Machine teardown without Linux: an inert kernel module that spawns one
// mocked worker, so device requests and closing hooks can be interleaved.

import assert from "node:assert/strict";
import test from "node:test";
import { bootMachine } from "../../src/machine/index.ts";
import type { MachinePlugin } from "../../src/machine/plugin.ts";
import { platform } from "../../src/machine/platform.ts";
import { type Device, public_handle, VirtioDevice } from "../../src/machine/virtio/device.ts";

const uleb = (value: number) => {
  const bytes = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return bytes;
};
const name = (text: string) => {
  const bytes = [...new TextEncoder().encode(text)];
  return [...uleb(bytes.length), ...bytes];
};
const section = (id: number, bytes: number[]) => [id, ...uleb(bytes.length), ...bytes];
const body = (code: number[]) => [...uleb(code.length + 1), 0, ...code];

// Imports shared memory and kernel.spawn_worker; boot() spawns one worker.
const bytes = new Uint8Array([
  ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
  ...section(1, [3, 0x60, 0, 0, 0x60, 1, 0x7f, 0, 0x60, 5, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f]),
  ...section(2, [
    2,
    ...name("env"),
    ...name("memory"),
    2,
    3,
    1,
    ...uleb(65535),
    ...name("kernel"),
    ...name("spawn_worker"),
    0,
    2,
  ]),
  ...section(3, [2, 0, 1]),
  ...section(7, [2, ...name("boot"), 0, 1, ...name("trigger_irq"), 0, 2]),
  ...section(10, [
    2,
    ...body([0x41, 0, 0x41, 0, 0x41, 0, 0x41, 0, 0x41, 0, 0x10, 0, 0x1a, 0x0b]),
    ...body([0x0b]),
  ]),
  ...section(0, [...name(".linux.sections"), ...new TextEncoder().encode("{}")]),
  ...section(0, name(".linux.initramfs")),
]);
const module = await WebAssembly.compile(bytes);
platform.load_wasm = async () => ({ bytes, module });
let terminations = 0;
platform.spawn_worker = () => ({
  post() {},
  async terminate() {
    terminations += 1;
  },
});

// A regression hangs rather than fails, hence the test timeouts.
const tick = () => new Promise(setImmediate);

class RequestDevice extends VirtioDevice {
  readonly handle: Device;
  closes = 0;

  constructor() {
    super({ id: 2, queues: 0 });
    this.handle = public_handle(this, {});
  }

  protected kick() {}

  protected close() {
    this.closes += 1;
  }

  request(work: Promise<void>) {
    this.spawn(work);
  }
}

test("a failed closing hook forces teardown past stuck requests", { timeout: 5000 }, async () => {
  const start = terminations;
  const device = new RequestDevice();
  const failure = new Error("sync timed out");
  let hooks = 0;
  let boot_console!: ReadableStreamDefaultReader<Uint8Array>;
  const plugin: MachinePlugin = {
    configure(setup) {
      boot_console = setup.bootConsole.getReader();
    },
    closing() {
      hooks += 1;
      throw failure;
    },
  };
  const machine = await bootMachine({ cpus: 1, plugins: [device.handle, plugin] });
  const boot_done = boot_console.read();
  const stuck = Promise.withResolvers<void>();
  device.request(stuck.promise);

  machine.close();
  machine.close();
  await assert.rejects(machine.closed, (error) => error === failure);
  assert.equal((await boot_done).done, true);
  assert.equal(hooks, 1);
  assert.equal(terminations - start, 1);
  assert.equal(device.closes, 0);

  // A request that fails after the teardown neither replaces the error nor
  // tears down again.
  stuck.reject(new Error("late storage failure"));
  await tick();
  await assert.rejects(machine.closed, (error) => error === failure);
  machine.close();
  assert.equal(terminations - start, 1);
  assert.equal(device.closes, 1);
});

test(
  "a closing hook failure escalates a teardown a device failure started",
  { timeout: 5000 },
  async () => {
    const start = terminations;
    const device = new RequestDevice();
    const hook = Promise.withResolvers<void>();
    const machine = await bootMachine({
      cpus: 1,
      plugins: [device.handle, { configure() {}, closing: () => hook.promise }],
    });
    const stuck = Promise.withResolvers<void>();
    device.request(stuck.promise);

    machine.close();
    // An unrelated request fails while the hook runs, starting an ordinary
    // teardown that waits for the stuck request.
    const device_failure = new Error("other storage request failed");
    device.request(Promise.reject(device_failure));
    await tick();
    assert.equal(terminations - start, 0);

    hook.reject(new Error("sync timed out"));
    await assert.rejects(machine.closed, (error) => error === device_failure);
    assert.equal(terminations - start, 1);
    stuck.resolve();
  },
);
