// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceTreeNode } from "../src/devicetree.ts";
import type { Machine } from "../src/index.ts";
import { configure_machine, run_machine_booted } from "../src/plugin-internal.ts";
import { getMachinePlugin, type MachinePlugin, type MachinePluginProvider } from "../src/plugin.ts";
import { VirtioController } from "../src/virtio/core.ts";

function machine_stub(): Machine {
  const closed = Promise.resolve();
  return {
    memory: {} as WebAssembly.Memory,
    bootConsole: new ReadableStream(),
    closed,
    close() {},
    [Symbol.dispose]() {},
    [Symbol.asyncDispose]: () => closed,
  };
}

test("plugins configure a machine in array order", async () => {
  const first = new VirtioController({ deviceId: 1 }, { queues: [] }).device;
  const second = new VirtioController({ deviceId: 2 }, { queues: [] }).device;
  const calls: string[] = [];
  const plugin: MachinePlugin = {
    configure(setup) {
      calls.push("plugin");
      setup.args.add("plugin=one", "plugin=two");
      setup.devices.add(first);
      setup.deviceTree.merge({
        chosen: { mode: "first", nested: { one: 1 } },
      });
      setup.deviceTree.merge({
        chosen: { mode: "second", nested: { two: 2 } },
      });
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
  assert.deepEqual(configured.deviceTree, {
    chosen: { mode: "second", nested: { one: 1, two: 2 } },
  } satisfies DeviceTreeNode);
});

test("virtio devices provide plugins without changing their device API", async () => {
  const controller = new VirtioController({ deviceId: 1 }, { queues: [] });
  const device = controller.expose({ capability: "available" as const });

  const configured = await configure_machine([], [device]);

  assert.equal(device.capability, "available");
  assert.deepEqual(configured.devices, [device]);
});

test("configuration failure closes devices already contributed", async () => {
  let closes = 0;
  const controller = new VirtioController(
    { deviceId: 1 },
    {
      queues: [],
      close() {
        closes += 1;
      },
    },
  );
  const failure = new Error("configuration failed");

  await assert.rejects(
    configure_machine(
      [],
      [
        controller.device,
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
  await controller.device.closed;
});

test("virtio devices expose their generic lifecycle", async () => {
  const controller = new VirtioController({ deviceId: 1 }, { queues: [] });
  let settled = false;
  void controller.device.closed.then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  controller.close();
  await controller.device.closed;
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
