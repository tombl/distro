// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { createNetwork } from "../../src/machine/network/network.ts";
import { configure_machine } from "../../src/machine/plugin-internal.ts";
import type { Device } from "../../src/machine/virtio/device.ts";
import { close_device } from "./virtio-fixture.ts";

function nics(devices: readonly Device[]) {
  return devices.filter((device) => "macAddress" in device);
}

const ip = (address: string) => `ip=${address}::192.0.2.1:255.255.255.0:lowland:eth0:off:192.0.2.1`;

test("an attachment adds the NIC and the kernel's ip= together", async () => {
  using network = createNetwork();
  const attachment = network.attach();
  assert.equal(attachment.address, "192.0.2.2");

  const configured = await configure_machine(["console=hvc0"], [attachment]);
  assert.deepEqual(configured.args, ["console=hvc0", ip("192.0.2.2")]);
  assert.equal(nics(configured.devices).length, 1);
  assert.deepEqual(
    (nics(configured.devices)[0] as unknown as { macAddress: readonly number[] }).macAddress,
    [0x02, 0, 0, 0, 0, 2],
  );
  await Promise.all(configured.devices.map(close_device));
});

test("a machine without an attachment has neither a NIC nor ip=", async () => {
  using network = createNetwork();
  network.attach();
  const configured = await configure_machine([], []);
  assert.deepEqual(configured.args, []);
  assert.deepEqual(nics(configured.devices), []);
});

test("a machine takes one network attachment", async () => {
  using network = createNetwork();
  using other = createNetwork();
  for (const second of [network.attach(), other.attach()]) {
    const first = network.attach();
    await assert.rejects(
      configure_machine([], [first, second]),
      new Error(
        "a machine takes one network attachment, because the kernel's ip= configures one interface",
      ),
    );
    // The failed configuration closed the first NIC, which detached it.
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      first.connect({ port: 1, transport: "udp" }),
      new Error(`${first.address} is not attached to this network`),
    );
  }
});

test("an attachment belongs to one machine", async () => {
  using network = createNetwork();
  const attachment = network.attach();
  const configured = await configure_machine([], [attachment]);
  await assert.rejects(
    configure_machine([], [attachment]),
    new Error("network attachment 192.0.2.2 is already attached to a machine"),
  );
  await Promise.all(configured.devices.map(close_device));
});

test("an attachment joins the network only when a machine configures it", async () => {
  using network = createNetwork();
  const attachment = network.attach();
  await assert.rejects(
    network.connect({ hostname: attachment.address, port: 1, transport: "udp" }),
    new Error("192.0.2.2 is not attached to this network"),
  );
  const configured = await configure_machine([], [attachment]);
  const channel = await attachment.connect({ port: 1, transport: "udp" });
  channel.close();
  await Promise.all(configured.devices.map(close_device));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    attachment.connect({ port: 1, transport: "udp" }),
    new Error("192.0.2.2 is not attached to this network"),
  );
});

test("a closed network attaches nothing", async () => {
  const network = createNetwork();
  const attachment = network.attach();
  network.close();
  assert.throws(() => network.attach(), new Error("network is closed"));
  await assert.rejects(configure_machine([], [attachment]), new Error("network is closed"));
});
