// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import type { Machine } from "../src/index.ts";
import {
  configure_machine,
  run_machine_booted,
  run_machine_closing,
} from "../src/plugin-internal.ts";
import {
  bootConsole,
  getMachinePlugin,
  type MachinePlugin,
  type MachinePluginProvider,
} from "../src/plugin.ts";
import { public_handle } from "../src/virtio/device.ts";
import { close_device, TestDevice } from "./virtio-fixture.ts";

function machine_stub(): Machine {
  const closed = Promise.resolve();
  return {
    memory: {} as WebAssembly.Memory,
    closed,
    close() {},
    [Symbol.dispose]() {},
    [Symbol.asyncDispose]: () => closed,
  };
}

test("plugins configure a machine in array order", async () => {
  const first = new TestDevice({ id: 1 }).handle;
  const second = new TestDevice({ id: 2 }).handle;
  const calls: string[] = [];
  const plugin: MachinePlugin = {
    configure(setup) {
      calls.push("plugin");
      setup.args.add("plugin=one", "plugin=two");
      setup.devices.add(first);
    },
  };
  const provider: MachinePluginProvider = {
    [getMachinePlugin]() {
      calls.push("provider");
      return {
        configure(setup) {
          calls.push("provided plugin");
          setup.devices.add(second);
        },
      };
    },
  };

  const configured = await configure_machine(["caller=first"], [plugin, provider]);

  assert.deepEqual(calls, ["plugin", "provider", "provided plugin"]);
  assert.deepEqual(configured.args, ["caller=first", "plugin=one", "plugin=two"]);
  assert.deepEqual(configured.devices, [first, second]);
});

test("boot console output attaches during configuration", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });
  const received = Promise.withResolvers<Uint8Array>();
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      received.resolve(chunk);
    },
  });

  await configure_machine([], [bootConsole(output)], stream);
  controller.enqueue(new Uint8Array([1, 2, 3]));

  assert.deepEqual(await received.promise, new Uint8Array([1, 2, 3]));
  controller.close();
});

test("virtio devices provide plugins without changing their device API", async () => {
  const device = public_handle(new TestDevice(), { capability: "available" as const });

  const configured = await configure_machine([], [device]);

  assert.equal(device.capability, "available");
  assert.deepEqual(configured.devices, [device]);
});

test("configuration failure closes devices already contributed", async () => {
  let closes = 0;
  const device = new TestDevice({
    close() {
      closes += 1;
    },
  });
  const failure = new Error("configuration failed");

  await assert.rejects(
    configure_machine(
      [],
      [
        device.handle,
        {
          configure() {
            throw failure;
          },
        },
      ],
    ),
    (error) => error === failure,
  );
  assert.equal(closes, 1);
  await device.handle.closed;
});

test("virtio devices expose their generic lifecycle", async () => {
  const device = new TestDevice().handle;
  let settled = false;
  void device.closed.then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  void close_device(device);
  await device.closed;
  assert.equal(settled, true);
});

test("booted hooks finish in plugin order", async () => {
  const calls: string[] = [];
  const first = Promise.withResolvers<void>();
  const plugins: MachinePlugin[] = [
    {
      configure() {},
      async booted() {
        calls.push("first started");
        await first.promise;
        calls.push("first finished");
      },
    },
    {
      configure() {},
      booted() {
        calls.push("second");
      },
    },
  ];

  const booted = run_machine_booted(plugins, machine_stub());
  await Promise.resolve();
  assert.deepEqual(calls, ["first started"]);
  first.resolve();
  await booted;
  assert.deepEqual(calls, ["first started", "first finished", "second"]);
});

test("every closing hook runs and the first failure is reported", async () => {
  const first_failure = new Error("last plugin failed");
  let earliest_ran = false;
  const plugins: MachinePlugin[] = [
    {
      configure() {},
      closing() {
        earliest_ran = true;
        throw new Error("first plugin failed");
      },
    },
    { configure() {} },
    {
      configure() {},
      async closing() {
        throw first_failure;
      },
    },
  ];

  await assert.rejects(run_machine_closing(plugins), (error) => error === first_failure);
  assert(earliest_ran);
});

test("closing hooks run one at a time in reverse plugin order", async () => {
  const calls: string[] = [];
  const last = Promise.withResolvers<void>();
  const plugins: MachinePlugin[] = [
    {
      configure() {},
      closing() {
        calls.push("first");
      },
    },
    {
      configure() {},
      async closing() {
        calls.push("last started");
        await last.promise;
        calls.push("last finished");
      },
    },
  ];

  const closing = run_machine_closing(plugins);
  await Promise.resolve();
  assert.deepEqual(calls, ["last started"]);
  last.resolve();
  await closing;
  assert.deepEqual(calls, ["last started", "last finished", "first"]);
});
