import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { guest_test, type TestGuest } from "./fixture.ts";
import { collect, connect_with_retry, pattern_bytes, read_with_retransmit } from "./helpers.ts";

// The virtio-net device holds at most 256 frames the guest has not taken yet
// and drops the oldest when full. Awaiting host writes never yields to the
// guest, so one burst this size fills the guest's posted receive buffers and
// that queue; a burst on each side of a TCP segment makes the device drop it.
const RECEIVE_QUEUE_BURST = 2048;

async function flood_receive_queue(writer: WritableStreamDefaultWriter<Uint8Array>) {
  const datagram = new Uint8Array(1);
  for (let index = 0; index < RECEIVE_QUEUE_BURST; index++) await writer.write(datagram);
}

async function wait_for_listener(guest: TestGuest, port: number) {
  const local = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  for (let attempt = 0; attempt < 500; attempt++) {
    const table = await guest.fs.readTextFile("/proc/net/tcp");
    const listening = table.split("\n").some((line) => {
      const fields = line.trim().split(/\s+/);
      return fields[1]?.endsWith(local) && fields[3] === "0A";
    });
    if (listening) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`guest port ${port} is not listening`);
}

guest_test("networking", async (t, fixture) => {
  const guest = await fixture.spawn();

  await t.test("connects from the host over TCP", async () => {
    const server = await guest.exec(["/tmp/network-test", "listen", "tcp", "12001"]);
    const server_output = collect(server.stdout);
    const server_error = collect(server.stderr);
    const connection = await connect_with_retry(() => guest.network.connect({ port: 12001 }));
    const writer = connection.writable.getWriter();
    await writer.write(new TextEncoder().encode("host to guest"));
    await writer.close();
    assert.equal(new TextDecoder().decode(await collect(connection.readable)), "host to guest");
    assert.deepEqual(await server.status, {
      success: true,
      code: 0,
      signal: null,
    });
    assert.equal((await server_output).byteLength, 0);
    assert.equal((await server_error).byteLength, 0);
  });

  await t.test("backpressures guest TCP output until the host reads", async () => {
    const length = 256 * 1024;
    const server = await guest.exec([
      "/tmp/network-test",
      "listen",
      "tcp",
      "12005",
      String(length),
    ]);
    const server_output = collect(server.stdout);
    const server_error = collect(server.stderr);
    const connection = await connect_with_retry(() => guest.network.connect({ port: 12005 }));
    const still_sending = Symbol("still sending");
    const before_read = await Promise.race([
      server.status,
      new Promise<typeof still_sending>((resolve) =>
        setTimeout(() => resolve(still_sending), 1_000),
      ),
    ]);
    assert.equal(before_read, still_sending);
    assert.deepEqual(await collect(connection.readable), pattern_bytes(length));
    connection.close();
    assert.deepEqual(await server.status, {
      success: true,
      code: 0,
      signal: null,
    });
    assert.equal((await server_output).byteLength, 0);
    assert.equal((await server_error).byteLength, 0);
  });

  await t.test("backpressures host TCP output until the guest reads", async () => {
    const length = 1024 * 1024;
    const server = await guest.exec([
      "/tmp/network-test",
      "receive",
      "tcp",
      "12006",
      String(length),
      "5",
    ]);
    const server_output = collect(server.stdout);
    const server_error = collect(server.stderr);
    const connection = await connect_with_retry(() => guest.network.connect({ port: 12006 }));
    const writer = connection.writable.getWriter();
    const write = writer.write(pattern_bytes(length));
    const still_writing = Symbol("still writing");
    const before_read = await Promise.race([
      write,
      new Promise<typeof still_writing>((resolve) =>
        setTimeout(() => resolve(still_writing), 1_000),
      ),
    ]);
    assert.equal(before_read, still_writing);
    await write;
    await writer.close();
    assert.deepEqual(await server.status, {
      success: true,
      code: 0,
      signal: null,
    });
    assert.equal((await server_output).byteLength, 0);
    assert.equal((await server_error).byteLength, 0);
  });

  await t.test("retransmits a host SYN dropped by the guest receive queue", async () => {
    const server = await guest.exec(["/tmp/network-test", "listen", "tcp", "12007"]);
    const server_output = collect(server.stdout);
    const server_error = collect(server.stderr);
    await wait_for_listener(guest, 12007);
    const flood = await guest.network.connect({ port: 12009, transport: "udp" });
    const flood_writer = flood.writable.getWriter();
    await flood_receive_queue(flood_writer);
    const connecting = guest.network.connect({ port: 12007 });
    await flood_receive_queue(flood_writer);
    const connection = await connecting;
    flood.close();
    const writer = connection.writable.getWriter();
    await writer.write(new TextEncoder().encode("after a lost SYN"));
    await writer.close();
    assert.equal(new TextDecoder().decode(await collect(connection.readable)), "after a lost SYN");
    assert.deepEqual(await server.status, {
      success: true,
      code: 0,
      signal: null,
    });
    assert.equal((await server_output).byteLength, 0);
    assert.equal((await server_error).byteLength, 0);
  });

  await t.test("retransmits host TCP data and FIN dropped by the guest receive queue", async () => {
    const server = await guest.exec(["/tmp/network-test", "listen", "tcp", "12008"]);
    const server_output = collect(server.stdout);
    const server_error = collect(server.stderr);
    const connection = await connect_with_retry(() => guest.network.connect({ port: 12008 }));
    const echoed = collect(connection.readable);
    const flood = await guest.network.connect({ port: 12009, transport: "udp" });
    const flood_writer = flood.writable.getWriter();
    const writer = connection.writable.getWriter();
    const payload = pattern_bytes(1000);
    await flood_receive_queue(flood_writer);
    const write = writer.write(payload);
    await flood_receive_queue(flood_writer);
    await write;
    await flood_receive_queue(flood_writer);
    const close = writer.close();
    await flood_receive_queue(flood_writer);
    await close;
    flood.close();
    assert.deepEqual(await echoed, payload);
    assert.deepEqual(await server.status, {
      success: true,
      code: 0,
      signal: null,
    });
    assert.equal((await server_output).byteLength, 0);
    assert.equal((await server_error).byteLength, 0);
  });

  await t.test("connects from the host over UDP", async () => {
    const server = await guest.exec(["/tmp/network-test", "listen", "udp", "12002"]);
    const server_output = collect(server.stdout);
    const server_error = collect(server.stderr);
    const connection = await guest.network.connect({ port: 12002, transport: "udp" });
    const writer = connection.writable.getWriter();
    const reader = connection.readable.getReader();
    const payload = new TextEncoder().encode("host datagram");
    const datagram = await read_with_retransmit(reader, () => writer.write(payload));
    assert.equal(datagram.done, false);
    assert.equal(new TextDecoder().decode(datagram.value), "host datagram");
    connection.close();
    assert.deepEqual(await server.status, {
      success: true,
      code: 0,
      signal: null,
    });
    assert.equal((await server_output).byteLength, 0);
    assert.equal((await server_error).byteLength, 0);
  });

  await t.test("transfers a maximum-size UDP datagram", async () => {
    const server = await guest.exec(["/tmp/network-test", "listen", "udp", "12004"]);
    const server_output = collect(server.stdout);
    const server_error = collect(server.stderr);
    const connection = await guest.network.connect({ port: 12004, transport: "udp" });
    const writer = connection.writable.getWriter();
    const reader = connection.readable.getReader();
    const payload = pattern_bytes(65507);
    const datagram = await read_with_retransmit(reader, () => writer.write(payload));
    assert.equal(datagram.done, false);
    assert.deepEqual(datagram.value, payload);
    connection.close();
    assert.deepEqual(await server.status, {
      success: true,
      code: 0,
      signal: null,
    });
    assert.equal((await server_output).byteLength, 0);
    assert.equal((await server_error).byteLength, 0);
  });

  await t.test("connects from the guest to the host", async () => {
    let settle_echo!: (error?: Error) => void;
    const host_echo = new Promise<void>((resolve, reject) => {
      settle_echo = (error) => (error ? reject(error) : resolve());
    });
    const listener = createServer((connection) => {
      connection.on("error", settle_echo);
      connection.on("close", () => settle_echo());
      connection.pipe(connection);
    });
    listener.once("close", () => settle_echo());
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address() as AddressInfo;
    try {
      const outbound = await guest.exec([
        "/tmp/network-test",
        "connect",
        fixture.network.gateway,
        String(address.port),
        "guest to host",
      ]);
      const [output, error, status] = await Promise.all([
        collect(outbound.stdout),
        collect(outbound.stderr),
        outbound.status,
      ]);
      await host_echo;
      assert.equal(new TextDecoder().decode(output), "guest to host");
      assert.equal(error.byteLength, 0);
      assert.deepEqual(status, { success: true, code: 0, signal: null });
    } finally {
      listener.close();
      await host_echo.catch(() => undefined);
    }
  });

  await t.test("connects between guests", async () => {
    const second = await fixture.spawn();
    const server = await guest.exec(["/tmp/network-test", "listen", "tcp", "12003"]);
    const server_output = collect(server.stdout);
    const server_error = collect(server.stderr);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const client = await second.exec([
      "/tmp/network-test",
      "connect",
      guest.network.address,
      "12003",
      "guest to guest",
    ]);
    const [output, error, status] = await Promise.all([
      collect(client.stdout),
      collect(client.stderr),
      client.status,
    ]);
    assert.equal(new TextDecoder().decode(output), "guest to guest");
    assert.equal(error.byteLength, 0);
    assert.deepEqual(status, { success: true, code: 0, signal: null });
    assert.deepEqual(await server.status, {
      success: true,
      code: 0,
      signal: null,
    });
    assert.equal((await server_output).byteLength, 0);
    assert.equal((await server_error).byteLength, 0);
  });
});
