import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { guest_test } from "./fixture.ts";
import { collect, connect_with_retry, read_with_retransmit } from "./helpers.ts";

guest_test("networking", async (t, fixture) => {
  const guest = await fixture.spawn();

  await t.test("connects from the host over TCP", async () => {
    const server = await guest.exec(["/workspace/network-test", "listen", "tcp", "12001"]);
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

  await t.test("connects from the host over UDP", async () => {
    const server = await guest.exec(["/workspace/network-test", "listen", "udp", "12002"]);
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
        "/workspace/network-test",
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
    const server = await guest.exec(["/workspace/network-test", "listen", "tcp", "12003"]);
    const server_output = collect(server.stdout);
    const server_error = collect(server.stderr);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const client = await second.exec([
      "/workspace/network-test",
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
