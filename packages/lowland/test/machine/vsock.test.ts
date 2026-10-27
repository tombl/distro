// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { vsockDevice } from "../../src/machine/virtio/vsock.ts";
import { attach_devices, close_device } from "./virtio-fixture.ts";

const HEADER_SIZE = 44;
const RING_SIZE = 64;
const AVAIL = 1 << 7;
const USED = 1 << 15;
const WRITE = 1 << 1;

const Op = { REQUEST: 1, RESPONSE: 2, RST: 3, SHUTDOWN: 4, RW: 5 } as const;
const Shutdown = { RCV: 1, SEND: 2 } as const;

interface Packet {
  src_port: number;
  dst_port: number;
  op: number;
  flags: number;
  payload: Uint8Array;
}

/**
 * A minimal guest driver for one vsock device: packed rx and tx rings that
 * never wrap, with buffers bump-allocated from the rest of the page.
 */
function guest(
  device: ReturnType<typeof vsockDevice>,
  { rx_buffers = Array<number>(16).fill(512) } = {},
) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const imports = attach_devices({
    memory,
    devices: [device],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const view = new DataView(memory.buffer);
  let generation = -1;
  let rx_ring = 0;
  let tx_ring = 0;
  let rx_posted = 0;
  let rx_seen = 0;
  let tx_posted = 0;
  let next_buffer = 16384;

  function allocate(size: number) {
    const address = next_buffer;
    next_buffer += (size + 15) & ~15;
    assert(next_buffer <= memory.buffer.byteLength, "test guest out of buffer space");
    return address;
  }

  function descriptor(ring: number, index: number, addr: number, len: number, flags: number) {
    const at = ring + index * 16;
    view.setBigUint64(at, BigInt(addr), true);
    view.setUint32(at + 8, len, true);
    view.setUint16(at + 12, index, true);
    view.setUint16(at + 14, flags, true);
  }

  // Brings the rings up, as the driver does at probe and after a reset.
  function start() {
    generation += 1;
    rx_ring = generation * 2 * RING_SIZE * 16;
    tx_ring = rx_ring + RING_SIZE * 16;
    rx_posted = rx_seen = tx_posted = 0;
    imports.enable_vring(0, 0, RING_SIZE, rx_ring, 1);
    imports.enable_vring(0, 1, RING_SIZE, tx_ring, 2);
    for (const size of rx_buffers) {
      descriptor(rx_ring, rx_posted++, allocate(size), size, AVAIL | WRITE);
    }
    imports.notify(0, 0);
  }

  function send(
    src_port: number,
    dst_port: number,
    op: number,
    { flags = 0, payload = new Uint8Array(), buf_alloc = 256 * 1024, fwd_cnt = 0 } = {},
  ) {
    const address = allocate(HEADER_SIZE + payload.byteLength);
    view.setBigUint64(address, 3n, true);
    view.setBigUint64(address + 8, 2n, true);
    view.setUint32(address + 16, src_port, true);
    view.setUint32(address + 20, dst_port, true);
    view.setUint32(address + 24, payload.byteLength, true);
    view.setUint16(address + 28, 1, true);
    view.setUint16(address + 30, op, true);
    view.setUint32(address + 32, flags, true);
    view.setUint32(address + 36, buf_alloc, true);
    view.setUint32(address + 40, fwd_cnt, true);
    new Uint8Array(memory.buffer, address + HEADER_SIZE).set(payload);
    descriptor(tx_ring, tx_posted++, address, HEADER_SIZE + payload.byteLength, AVAIL);
    imports.notify(0, 1);
  }

  /** Packets the device has delivered since the last call. */
  function received(): Packet[] {
    const packets: Packet[] = [];
    while (rx_seen < rx_posted) {
      const at = rx_ring + rx_seen * 16;
      if (!(view.getUint16(at + 14, true) & USED)) break;
      const address = Number(view.getBigUint64(at, true));
      const len = view.getUint32(address + 24, true);
      packets.push({
        src_port: view.getUint32(address + 16, true),
        dst_port: view.getUint32(address + 20, true),
        op: view.getUint16(address + 30, true),
        flags: view.getUint32(address + 32, true),
        payload: new Uint8Array(memory.buffer, address + HEADER_SIZE, len).slice(),
      });
      rx_seen += 1;
    }
    return packets;
  }

  function reset() {
    imports.reset(0, 0);
  }

  start();
  return { send, received, reset, start };
}

function ops(packets: Packet[]) {
  return packets.map((packet) => packet.op);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a stale vsock handler cannot reset the connection that replaced it", async () => {
  const device = vsockDevice();
  const vm = guest(device);
  const first = Promise.withResolvers<void>();
  let calls = 0;
  const writes: Promise<void>[] = [];
  device.listen(1234, async (connection) => {
    calls += 1;
    if (calls === 1) return first.promise;
    writes.push(connection.write(new TextEncoder().encode("new")));
    await new Promise(() => {});
  });

  vm.send(5000, 1234, Op.REQUEST);
  await tick();
  assert.deepEqual(ops(vm.received()), [Op.RESPONSE]);

  vm.reset();
  vm.start();
  vm.send(5000, 1234, Op.REQUEST);
  await tick();
  assert.equal(calls, 2);

  const original_error = console.error;
  console.error = () => {};
  try {
    first.reject(new Error("old handler fails late"));
    await tick();
  } finally {
    console.error = original_error;
  }

  await writes[0];
  assert.deepEqual(ops(vm.received()), [Op.RESPONSE, Op.RW]);
  // The device is left with a handler that never settles, so it is not shut
  // down here.
});

test("vsock device shutdown waits for listener handlers", async () => {
  const device = vsockDevice();
  const vm = guest(device);
  let cleaned_up = false;
  const listener = device.listen(1234, async (connection) => {
    while ((await connection.read()).byteLength > 0);
    await tick();
    cleaned_up = true;
  });
  let finished = false;
  void listener.finished.then(() => {
    finished = true;
  });

  vm.send(5000, 1234, Op.REQUEST);
  await tick();
  await close_device(device);
  assert.equal(cleaned_up, true, "shutdown resolved before the handler settled");
  assert.equal(finished, true, "listener.finished is still pending after shutdown");
});

test("a guest receive shutdown ends host writes but not reads", async () => {
  const device = vsockDevice();
  const vm = guest(device);
  const accepted = Promise.withResolvers<{
    write: (data: Uint8Array) => Promise<void>;
    read: () => Promise<Uint8Array>;
  }>();
  const done = Promise.withResolvers<void>();
  device.listen(1234, async (connection) => {
    accepted.resolve(connection);
    await done.promise;
  });

  // Advertising no buffer space parks the first write waiting for credit.
  vm.send(5000, 1234, Op.REQUEST, { buf_alloc: 0 });
  const connection = await accepted.promise;
  const blocked = connection.write(new Uint8Array([1]));
  await tick();

  vm.send(5000, 1234, Op.SHUTDOWN, { flags: Shutdown.RCV, buf_alloc: 0 });
  await assert.rejects(blocked, /receive side/);
  await assert.rejects(connection.write(new Uint8Array([2])), /receive side/);

  vm.send(5000, 1234, Op.RW, { payload: new Uint8Array([7, 8]), buf_alloc: 0 });
  assert.deepEqual([...(await connection.read())], [7, 8]);
  assert.deepEqual(ops(vm.received()), [Op.RESPONSE]);

  done.resolve();
  await close_device(device);
});

test("a failed reset delivery does not stall vsock shutdown", async () => {
  const device = vsockDevice();
  const vm = guest(device, { rx_buffers: [512, 8] });
  let settled = false;
  device.listen(1234, async (connection) => {
    while ((await connection.read()).byteLength > 0);
    settled = true;
  });

  vm.send(5000, 1234, Op.REQUEST);
  await tick();
  await assert.rejects(close_device(device), /vsock rx buffer too small/);
  assert.equal(settled, true);
});
