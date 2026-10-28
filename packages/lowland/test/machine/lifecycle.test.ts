// SPDX-License-Identifier: MIT

// The machine's lifecycle without Linux: an inert kernel module whose boot()
// spawns one mocked worker. The test plays the kernel: it posts the
// worker's termination messages and answers the power button.

import assert from "node:assert/strict";
import test from "node:test";
import { bootMachine, MachinePanicError } from "../../src/machine/index.ts";
import type { MachinePlugin } from "../../src/machine/plugin.ts";
import { platform, type WorkerHandlers } from "../../src/machine/platform.ts";
import { type Device, public_handle, VirtioDevice } from "../../src/machine/virtio/device.ts";
import { serveDevice, workerDevice } from "../../src/machine/virtio/remote.ts";
import { MachineTerminationReason } from "../../src/machine/wasm.ts";
import { TestDevice } from "./virtio-fixture.ts";

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

interface Kernel {
  handlers: WorkerHandlers;
  terminated: boolean;
}
// One mocked worker per boot, in boot order.
let kernels: Kernel[] = [];
platform.spawn_worker = (_name, handlers) => {
  const kernel: Kernel = { handlers, terminated: false };
  kernels.push(kernel);
  return {
    post() {},
    async terminate() {
      kernel.terminated = true;
    },
  };
};

// The inert module has no power button; each instance gets the test's.
type Press = (action: number) => number;
let power_button: Press = () => 0;
const presses: number[] = [];
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = (async (source: WebAssembly.Module, imports?: WebAssembly.Imports) => {
  const instance = await instantiate(source, imports);
  return {
    exports: {
      ...instance.exports,
      power_button(action: number) {
        presses.push(action);
        return power_button(action);
      },
    },
  };
}) as unknown as typeof WebAssembly.instantiate;

const terminate = (kernel: Kernel, reason: number) =>
  kernel.handlers.on_message({ type: "terminate_machine", reason });
const current = () => kernels.at(-1)!;

// Every test starts with a fresh kernel list and a button that does nothing.
function reset() {
  kernels = [];
  presses.length = 0;
  power_button = () => 0;
}

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

test("a guest power-off ends the machine", { timeout: 5000 }, async () => {
  reset();
  const machine = await bootMachine({ cpus: 1 });
  terminate(current(), MachineTerminationReason.Clean);
  assert.deepEqual(await machine.exited, { reason: "poweroff" });
  assert.equal(current().terminated, true);
  // Later calls see the machine as it ended.
  assert.deepEqual(await machine.shutdown(), { reason: "poweroff" });
  await assert.rejects(machine.reboot(), /the machine has ended: poweroff/);
  machine.kill();
  assert.deepEqual(await machine.exited, { reason: "poweroff" });
});

test("a panic is a crash", { timeout: 5000 }, async () => {
  reset();
  const machine = await bootMachine({ cpus: 1 });
  terminate(current(), MachineTerminationReason.Panic);
  const exit = await machine.exited;
  assert.equal(exit.reason, "crash");
  assert.ok(exit.reason === "crash" && exit.error instanceof MachinePanicError);
});

test("shutdown asks power hooks in reverse order", { timeout: 5000 }, async () => {
  reset();
  const calls: string[] = [];
  const hook = (name: string, answer: boolean | Error): MachinePlugin => ({
    configure() {},
    async power(action) {
      calls.push(`${name} ${action}`);
      if (answer instanceof Error) throw answer;
      if (answer) setTimeout(() => terminate(current(), MachineTerminationReason.Clean), 10);
      return answer;
    },
  });
  const machine = await bootMachine({
    cpus: 1,
    plugins: [
      hook("first", false),
      hook("second", true),
      hook("third", new Error("not now")),
      hook("fourth", false),
    ],
  });
  assert.deepEqual(await machine.shutdown(), { reason: "poweroff" });
  assert.deepEqual(calls, ["fourth poweroff", "third poweroff", "second poweroff"]);
  assert.deepEqual(presses, []);
});

test(
  "with no hook answering, shutdown presses the kernel's button",
  { timeout: 5000 },
  async () => {
    reset();
    const machine = await bootMachine({
      cpus: 1,
      plugins: [{ configure() {}, power: () => false }],
    });
    // -EAGAIN before the button is registered, then a press.
    let early = 2;
    power_button = () => {
      if (early-- > 0) return -11;
      setTimeout(() => terminate(current(), MachineTerminationReason.Clean), 10);
      return 0;
    };
    assert.deepEqual(await machine.shutdown(), { reason: "poweroff" });
    assert.deepEqual(presses, [1, 1, 1]);
  },
);

test("a press during a shutdown under way waits for it", { timeout: 5000 }, async () => {
  reset();
  const machine = await bootMachine({ cpus: 1 });
  // -EBUSY: the guest is already shutting down.
  power_button = () => -16;
  const exit = machine.shutdown({ timeoutMs: 2000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(current().terminated, false);
  terminate(current(), MachineTerminationReason.Clean);
  assert.deepEqual(await exit, { reason: "poweroff" });
});

test("a broken power button kills the machine", { timeout: 5000 }, async () => {
  reset();
  const machine = await bootMachine({ cpus: 1 });
  power_button = () => -22;
  assert.deepEqual(await machine.shutdown(), { reason: "kill" });
});

test("a guest that ignores the button is killed after the timeout", { timeout: 5000 }, async () => {
  reset();
  const machine = await bootMachine({ cpus: 1 });
  const started = performance.now();
  assert.deepEqual(await machine.shutdown({ timeoutMs: 200 }), { reason: "kill" });
  assert.ok(performance.now() - started >= 190);
  assert.equal(current().terminated, true);
});

test("a hook that never settles still ends in the timeout", { timeout: 5000 }, async () => {
  reset();
  const machine = await bootMachine({
    cpus: 1,
    plugins: [{ configure() {}, power: () => new Promise<boolean>(() => {}) }],
  });
  assert.deepEqual(await machine.shutdown({ timeoutMs: 200 }), { reason: "kill" });
});

test("await using shuts the machine down", { timeout: 5000 }, async () => {
  reset();
  let exited;
  {
    await using machine = await bootMachine({ cpus: 1 });
    power_button = () => {
      setTimeout(() => terminate(current(), MachineTerminationReason.Clean), 10);
      return 0;
    };
    exited = machine.exited;
  }
  assert.deepEqual(await exited, { reason: "poweroff" });
});

test("kill does not wait for a request stuck in host storage", { timeout: 5000 }, async () => {
  reset();
  const device = new RequestDevice();
  const machine = await bootMachine({ cpus: 1, plugins: [device.handle] });
  const stuck = Promise.withResolvers<void>();
  device.request(stuck.promise);
  machine.kill();
  assert.deepEqual(await machine.exited, { reason: "kill" });
  assert.equal(device.closes, 0);
  // A request that fails after the kill changes nothing.
  stuck.reject(new Error("late storage failure"));
  await tick();
  assert.equal(device.closes, 1);
  assert.deepEqual(await machine.exited, { reason: "kill" });
});

test("a power-off waits for the devices to close", { timeout: 5000 }, async () => {
  reset();
  const device = new RequestDevice();
  const machine = await bootMachine({ cpus: 1, plugins: [device.handle] });
  const pending = Promise.withResolvers<void>();
  device.request(pending.promise);
  terminate(current(), MachineTerminationReason.Clean);
  let ended = false;
  void machine.exited.then(() => (ended = true));
  await tick();
  assert.equal(ended, false);
  // A kill while the devices close stops waiting for them.
  machine.kill();
  assert.deepEqual(await machine.exited, { reason: "kill" });
  pending.resolve();
});

test("a device failure while powering off is a crash", { timeout: 5000 }, async () => {
  reset();
  const device = new RequestDevice();
  const machine = await bootMachine({ cpus: 1, plugins: [device.handle] });
  const failure = new Error("flush failed");
  const pending = Promise.withResolvers<void>();
  device.request(pending.promise);
  terminate(current(), MachineTerminationReason.Clean);
  pending.reject(failure);
  const exit = await machine.exited;
  assert.equal(exit.reason, "crash");
});

test("a reboot restarts the same devices", { timeout: 5000 }, async () => {
  reset();
  const calls: string[] = [];
  const device = new TestDevice({
    reset: () => calls.push("reset"),
    restart: () => calls.push("restart"),
  });
  let boots = 0;
  const plugin: MachinePlugin = {
    configure() {
      calls.push("configure");
    },
    booted() {
      boots += 1;
    },
    power(action) {
      calls.push(action);
      setTimeout(() => terminate(current(), MachineTerminationReason.Reboot), 10);
      return true;
    },
  };
  const machine = await bootMachine({ cpus: 1, plugins: [device.handle, plugin] });
  const memory = machine.memory;
  const first = current();
  await machine.reboot();
  assert.equal(boots, 2);
  assert.equal(kernels.length, 2);
  assert.equal(first.terminated, true);
  assert.notEqual(machine.memory, memory);
  assert.deepEqual(calls, ["configure", "reboot", "reset", "restart"]);

  // The old kernel's workers are ignored.
  terminate(first, MachineTerminationReason.Clean);
  await tick();
  // A guest-initiated reboot restarts too.
  terminate(current(), MachineTerminationReason.Reboot);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(boots, 3);
  assert.equal(kernels.length, 3);
  terminate(current(), MachineTerminationReason.Clean);
  assert.deepEqual(await machine.exited, { reason: "poweroff" });
});

test("reboot: exit ends the machine on a reboot", { timeout: 5000 }, async () => {
  reset();
  const machine = await bootMachine({ cpus: 1, reboot: "exit" });
  power_button = (action) => {
    assert.equal(action, 2);
    setTimeout(() => terminate(current(), MachineTerminationReason.Reboot), 10);
    return 0;
  };
  await assert.rejects(machine.reboot(), /ended instead of rebooting: reboot/);
  assert.deepEqual(await machine.exited, { reason: "reboot" });
});

test("a booted hook failure on a reboot is a crash", { timeout: 5000 }, async () => {
  reset();
  const failure = new Error("not again");
  let boots = 0;
  const machine = await bootMachine({
    cpus: 1,
    plugins: [
      {
        configure() {},
        booted() {
          if (boots++) throw failure;
        },
      },
    ],
  });
  terminate(current(), MachineTerminationReason.Reboot);
  assert.deepEqual(await machine.exited, { reason: "crash", error: failure });
});

test(
  "a reboot that does not boot again is killed after the timeout",
  { timeout: 5000 },
  async () => {
    reset();
    const machine = await bootMachine({ cpus: 1 });
    await assert.rejects(machine.reboot({ timeoutMs: 200 }), /ended instead of rebooting: kill/);
  },
);

test("the boot console carries every boot's early output", { timeout: 5000 }, async () => {
  reset();
  let reader!: ReadableStreamDefaultReader<Uint8Array>;
  const machine = await bootMachine({
    cpus: 1,
    plugins: [{ configure: (setup) => void (reader = setup.bootConsole.getReader()) }],
  });
  const write = (text: string) =>
    current().handlers.on_message({
      type: "boot_console_write",
      message: new TextEncoder().encode(text).buffer,
    });
  write("first boot");
  current().handlers.on_message({ type: "boot_console_close" });
  terminate(current(), MachineTerminationReason.Reboot);
  await new Promise((resolve) => setTimeout(resolve, 50));
  write("second boot");
  const decoder = new TextDecoder();
  assert.equal(decoder.decode((await reader.read()).value), "first boot");
  assert.equal(decoder.decode((await reader.read()).value), "second boot");
  machine.kill();
  assert.equal((await reader.read()).done, true);
});

test("a reboot restarts a device served from a worker", { timeout: 5000 }, async () => {
  reset();
  const channel = new MessageChannel();
  const calls: string[] = [];
  serveDevice(
    channel.port2,
    new TestDevice({
      reset: () => calls.push("reset"),
      restart: () => calls.push("restart"),
    }).handle,
  );
  const device = await workerDevice(channel.port1);
  let boots = 0;
  const machine = await bootMachine({
    cpus: 1,
    plugins: [device, { configure() {}, booted: () => void boots++ }],
  });
  terminate(current(), MachineTerminationReason.Reboot);
  for (let i = 0; i < 100 && boots < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(boots, 2);
  assert.deepEqual(calls, ["reset", "restart"]);
  machine.kill();
  await machine.exited;
  await device.closed;
  channel.port1.close();
});

// Settles within `ms`, or reports "pending".
const within = (promise: Promise<unknown>, ms = 500) =>
  Promise.race([
    promise.then(
      (value) => ({ state: "resolved", value }),
      (error: unknown) => ({ state: "rejected", error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ state: "pending" }), ms)),
  ]);

test("a hook that throws synchronously declines", { timeout: 5000 }, async () => {
  reset();
  const machine = await bootMachine({
    cpus: 1,
    plugins: [
      {
        configure() {},
        power() {
          throw new Error("no agent");
        },
      },
    ],
  });
  power_button = () => {
    setImmediate(() => terminate(current(), MachineTerminationReason.Clean));
    return 0;
  };
  assert.deepEqual(await machine.shutdown({ timeoutMs: 1000 }), { reason: "poweroff" });
  assert.equal(presses.length, 1);
});

test(
  "shutdown's timeout covers a machine still closing its devices",
  { timeout: 5000 },
  async () => {
    reset();
    const device = new RequestDevice();
    const work = Promise.withResolvers<void>();
    const machine = await bootMachine({ cpus: 1, plugins: [device.handle] });
    device.request(work.promise);
    // The guest powers off, and the device's request never finishes.
    terminate(current(), MachineTerminationReason.Clean);
    await tick();
    const outcome = await within(machine.shutdown({ timeoutMs: 20 }));
    assert.deepEqual(outcome, { state: "resolved", value: { reason: "kill" } });
    work.resolve();
  },
);

test("reboot's timeout covers a reboot already under way", { timeout: 5000 }, async () => {
  reset();
  let boots = 0;
  const stuck = Promise.withResolvers<void>();
  const machine = await bootMachine({
    cpus: 1,
    plugins: [
      {
        configure() {},
        async booted() {
          if (++boots === 2) await stuck.promise;
        },
      },
    ],
  });
  // The guest reboots, and the next boot's hook never finishes.
  terminate(current(), MachineTerminationReason.Reboot);
  await tick();
  const outcome = (await within(machine.reboot({ timeoutMs: 20 }))) as { state: string };
  assert.equal(outcome.state, "rejected");
  assert.deepEqual(await machine.exited, { reason: "kill" });
  stuck.resolve();
});

test("a reboot during a reboot's booted hooks boots again", { timeout: 5000 }, async () => {
  reset();
  let boots = 0;
  const slow = Promise.withResolvers<void>();
  const machine = await bootMachine({
    cpus: 1,
    plugins: [
      {
        configure() {},
        async booted() {
          if (++boots === 2) await slow.promise;
        },
      },
    ],
  });
  power_button = () => {
    setImmediate(() => terminate(current(), MachineTerminationReason.Reboot));
    return 0;
  };
  const reboot = machine.reboot({ timeoutMs: 2000 });
  while (boots < 2) await tick();
  // The second kernel reboots while its booted hook still runs.
  terminate(current(), MachineTerminationReason.Reboot);
  slow.resolve();
  await reboot;
  assert.equal(kernels.length, 3);
  assert.equal(boots, 3);
  machine.kill();
  await machine.exited;
});

test("a power hook is called on its plugin", { timeout: 5000 }, async () => {
  reset();
  class Agent implements MachinePlugin {
    asked: string[] = [];
    configure() {}
    power(action: "poweroff" | "reboot") {
      this.asked.push(action);
      setImmediate(() => terminate(current(), MachineTerminationReason.Clean));
      return true;
    }
  }
  const agent = new Agent();
  const machine = await bootMachine({ cpus: 1, plugins: [agent] });
  assert.deepEqual(await machine.shutdown({ timeoutMs: 1000 }), { reason: "poweroff" });
  assert.deepEqual(agent.asked, ["poweroff"]);
  assert.equal(presses.length, 0);
});
