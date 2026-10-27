// SPDX-License-Identifier: MIT

// A virtio-fs device outlives the guest's FUSE sessions: a reboot or the
// guest's DESTROY releases what that session left open, and only the
// device's close destroys the filesystem.

import assert from "node:assert/strict";
import test from "node:test";
import { device_of } from "../../src/machine/virtio/device.ts";
import { fileSystemDevice } from "../../src/machine/virtio/fs.ts";

const FUSE_OPEN = 14;
const FUSE_DESTROY = 38;

test("a reboot or DESTROY ends the session, and close destroys", async () => {
  const counts = { opened: 0, released: 0, destroyed: 0 };
  const device = device_of(
    fileSystemDevice(
      {
        root: {},
        lookup() {},
        getattr: () => ({ mode: 0o100644, size: 0n }),
        open() {
          counts.opened++;
          return {};
        },
        release() {
          counts.released++;
        },
        destroy() {
          counts.destroyed++;
        },
      },
      { tag: "session" },
    ),
  );
  const attach = () =>
    device.attach({
      memory: new WebAssembly.Memory({ initial: 1 }),
      trigger_irq() {},
      on_error(error) {
        throw error;
      },
    });
  // One request on the request queue, as the guest would make it, on the
  // root node.
  const request = async (opcode: number) => {
    const header = new Uint8Array(opcode === FUSE_OPEN ? 48 : 40);
    const view = new DataView(header.buffer);
    view.setUint32(0, header.length, true);
    view.setUint32(4, opcode, true);
    view.setBigUint64(8, 1n, true);
    view.setBigUint64(16, 1n, true);
    const reply = new Uint8Array(256);
    const chain = Object.assign(
      [
        { array: header, writable: false },
        { array: reply, writable: true },
      ],
      { release() {} },
    );
    await (device as unknown as { kick(vq: number, queue: unknown): Promise<void> }).kick(1, [
      chain,
    ]);
    assert.equal(new DataView(reply.buffer).getInt32(4, true), 0);
  };

  // A forced reboot sends no DESTROY.
  attach();
  await request(FUSE_OPEN);
  await device.detach();
  assert.deepEqual(counts, { opened: 1, released: 1, destroyed: 0 });

  // An unmount's DESTROY ends the session, but the next boot can mount again.
  attach();
  await request(FUSE_OPEN);
  await request(FUSE_DESTROY);
  assert.deepEqual(counts, { opened: 2, released: 2, destroyed: 0 });
  await device.detach();

  attach();
  await request(FUSE_OPEN);
  await device.shutdown();
  assert.deepEqual(counts, { opened: 3, released: 3, destroyed: 1 });
});

test("a close while a reboot ends the session waits for it", async () => {
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const device = device_of(
    fileSystemDevice(
      {
        root: {},
        lookup() {},
        getattr: () => ({ mode: 0o100644, size: 0n }),
        open: () => ({}),
        async release() {
          events.push("release");
          await release.promise;
          events.push("released");
        },
        destroy() {
          events.push("destroy");
        },
      },
      { tag: "concurrent" },
    ),
  );
  device.attach({
    memory: new WebAssembly.Memory({ initial: 1 }),
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const header = new Uint8Array(48);
  const view = new DataView(header.buffer);
  view.setUint32(0, header.length, true);
  view.setUint32(4, FUSE_OPEN, true);
  view.setBigUint64(8, 1n, true);
  view.setBigUint64(16, 1n, true);
  const chain = Object.assign(
    [
      { array: header, writable: false },
      { array: new Uint8Array(256), writable: true },
    ],
    { release() {} },
  );
  await (device as unknown as { kick(vq: number, queue: unknown): Promise<void> }).kick(1, [chain]);
  // A reboot's session end is releasing the handle when the device closes.
  const detached = device.detach();
  await new Promise(setImmediate);
  const closed = device.shutdown();
  await new Promise(setImmediate);
  assert.deepEqual(events, ["release"]);
  release.resolve();
  await Promise.all([detached, closed]);
  assert.deepEqual(events, ["release", "released", "destroy"]);
});
