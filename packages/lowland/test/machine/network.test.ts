// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { createNetwork } from "../../src/machine/network/network.ts";
import type { Machine } from "../../src/machine/index.ts";
import { configure_machine, run_machine_booted } from "../../src/machine/plugin-internal.ts";
import type { MachinePlugin } from "../../src/machine/plugin.ts";
import type { Device } from "../../src/machine/virtio/device.ts";
import { device_of } from "../../src/machine/virtio/device.ts";
import { attach_devices, close_device } from "./virtio-fixture.ts";

function nics(devices: readonly Device[]) {
  return devices.filter((device) => "macAddress" in device);
}

const ip = (address: string) => `ip=${address}::192.0.2.1:255.255.255.0:lowland:eth0:off:192.0.2.1`;

const failing: MachinePlugin = {
  configure() {
    throw new Error("a later plugin failed");
  },
};

/** Configures a machine with `attachment` and runs its booted hooks, as a boot does. */
async function boot(attachment: Parameters<typeof configure_machine>[1][number]) {
  const configured = await configure_machine([], [attachment]);
  await run_machine_booted(configured.plugins, {} as Machine);
  return configured;
}

test("an attachment adds the NIC and the kernel's ip= together", async () => {
  using network = createNetwork();
  const attachment = network.attach();
  const configured = await configure_machine(["console=hvc0"], [attachment]);
  assert.equal(attachment.address, "192.0.2.2");
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
  assert.throws(
    () => attachment.address,
    new Error("a network attachment has no address until a machine configures it"),
  );
  await assert.rejects(
    attachment.connect({ port: 1, transport: "udp" }),
    new Error("the attachment is not attached to this network"),
  );
  await assert.rejects(
    network.connect({ hostname: "192.0.2.2", port: 1, transport: "udp" }),
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

test("attachments that no machine configures take no addresses", async () => {
  using network = createNetwork();
  for (let i = 0; i < 300; i++) network.attach();
  const attachment = network.attach();
  const configured = await configure_machine([], [attachment]);
  assert.equal(attachment.address, "192.0.2.2");
  await Promise.all(configured.devices.map(close_device));
});

test("a machine that fails before it boots gives its address back", async () => {
  using network = createNetwork();
  for (let i = 0; i < 300; i++) {
    const attachment = network.attach();
    await assert.rejects(configure_machine([], [attachment, failing]), /a later plugin failed/);
    assert.equal(attachment.address, "192.0.2.2");
    await new Promise((resolve) => setImmediate(resolve));
  }
  const attachment = network.attach();
  const configured = await boot(attachment);
  assert.equal(attachment.address, "192.0.2.2");
  await Promise.all(configured.devices.map(close_device));
});

test("an address that a machine booted with is not handed out again", async () => {
  using network = createNetwork();
  const first = network.attach();
  const configured = await boot(first);
  assert.equal(first.address, "192.0.2.2");
  await Promise.all(configured.devices.map(close_device));
  await new Promise((resolve) => setImmediate(resolve));
  // The first machine is gone, but its address is not reused, so a stale
  // caller cannot reach a different machine through it.
  await assert.rejects(
    first.connect({ port: 1, transport: "udp" }),
    new Error("192.0.2.2 is not attached to this network"),
  );
  const second = network.attach();
  const next = await configure_machine([], [second]);
  assert.equal(second.address, "192.0.2.3");
  await Promise.all(next.devices.map(close_device));
});

test("a network runs out after 253 booted machines", async () => {
  using network = createNetwork();
  for (let suffix = 2; suffix <= 254; suffix++) {
    const attachment = network.attach();
    const configured = await boot(attachment);
    assert.equal(attachment.address, `192.0.2.${suffix}`);
    await Promise.all(configured.devices.map(close_device));
  }
  await assert.rejects(
    configure_machine([], [network.attach()]),
    new Error("network has no guest addresses left"),
  );
});

test("a reboot forgets the guest's connections and keeps its address", async () => {
  using network = createNetwork();
  const attachment = network.attach();
  const configured = await boot(attachment);
  const [nic] = nics(configured.devices);
  assert.ok(nic);
  attach_devices({
    memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
    devices: [nic],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const channel = await attachment.connect({ port: 1, transport: "udp" });
  const reader = channel.readable.getReader();
  await device_of(nic).detach();
  // The previous boot's flow ended, as its socket did.
  assert.equal((await reader.read()).done, true);
  await assert.rejects(
    channel.writable.getWriter().write(new Uint8Array(1)),
    /UDP connection is closed/,
  );
  // The address and the NIC stay, for the next boot.
  assert.equal(attachment.address, "192.0.2.2");
  const next = await attachment.connect({ port: 1, transport: "udp" });
  next.close();
  await Promise.all(configured.devices.map(close_device));
});
