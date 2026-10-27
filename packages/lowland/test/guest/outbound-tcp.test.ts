import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer as create_http_server, type Server as HttpServer } from "node:http";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { guest_test, type OutboundSession, type TestFixture } from "./fixture.ts";
import { collect, pattern_bytes } from "./helpers.ts";

const decoder = new TextDecoder();

async function listen<T extends Server | HttpServer>(server: T) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

function session_for(fixture: TestFixture, port: number): OutboundSession {
  const session = fixture.outbound.findLast((session) => session.target.port === port);
  assert.ok(session, `no outbound session to port ${port}`);
  return session;
}

/** Both directions ended with a FIN, and nothing reset the flow. */
async function assert_graceful(session: OutboundSession) {
  const pipes = await session.pipes;
  assert.deepEqual(
    pipes.map((pipe) => (pipe.status === "rejected" ? String(pipe.reason) : pipe.status)),
    ["fulfilled", "fulfilled"],
  );
  assert.equal(session.signal.aborted, false, String(session.signal.reason));
}

guest_test("outbound TCP", async (t, fixture) => {
  const guest = await fixture.spawn();

  async function run(command: string) {
    const process = await guest.spawn(["/bin/sh", "-c", command]);
    const [stdout, stderr, status] = await Promise.all([
      collect(process.stdout),
      collect(process.stderr),
      process.status,
    ]);
    return { stdout: decoder.decode(stdout), stderr: decoder.decode(stderr), status };
  }

  // Each response is complete and followed by the server's FIN straight
  // away: the case where an early reset would cut the guest off.
  async function serve(body: Uint8Array, fn: (url: string, port: number) => Promise<void>) {
    const sockets: Socket[] = [];
    const server = create_http_server((_request, response) => {
      response.setHeader("connection", "close");
      response.setHeader("content-length", body.byteLength);
      response.end(body);
    });
    server.on("connection", (socket) => sockets.push(socket));
    const port = await listen(server);
    try {
      await fn(`http://${fixture.network.gateway}:${port}/`, port);
    } finally {
      server.close();
      for (const socket of sockets) socket.destroy();
    }
  }

  await t.test("delivers a complete response, then FIN, without a reset", async () => {
    const body = pattern_bytes(1256);
    await serve(body, async (url, port) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await run(`wget -O /tmp/out ${url} && wc -c < /tmp/out`);
        assert.equal(result.stderr.includes("reset"), false, result.stderr);
        assert.deepEqual(result.status, { success: true, code: 0, signal: null }, result.stderr);
        assert.equal(result.stdout.trim(), String(body.byteLength));
        await assert_graceful(session_for(fixture, port));
      }
    });
  });

  await t.test("delivers a large response intact", async () => {
    const body = pattern_bytes(8 * 1024 * 1024);
    const digest = createHash("sha256").update(body).digest("hex");
    await serve(body, async (url, port) => {
      const result = await run(`wget -qO- ${url} | sha256sum`);
      assert.deepEqual(result.status, { success: true, code: 0, signal: null }, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.split(" ")[0], digest);
      await assert_graceful(session_for(fixture, port));
    });
  });

  await t.test("delivers a response delimited by the server's FIN", async () => {
    // No Content-Length: wget reads until EOF and only then closes its side,
    // so the host must pass on the server's FIN while staying half-open.
    const body = pattern_bytes(4096);
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => {
        socket.write("HTTP/1.0 200 OK\r\n\r\n");
        socket.end(body);
      });
    });
    const port = await listen(server);
    try {
      const result = await run(
        `wget -O /tmp/out http://${fixture.network.gateway}:${port}/ && wc -c < /tmp/out`,
      );
      assert.deepEqual(result.status, { success: true, code: 0, signal: null }, result.stderr);
      assert.equal(result.stdout.trim(), String(body.byteLength));
      await assert_graceful(session_for(fixture, port));
    } finally {
      server.close();
    }
  });

  await t.test("ends the session's readable when the guest closes first", async () => {
    // The host echoes but keeps its side open until it sees the guest's FIN.
    const received = Promise.withResolvers<{ data: string; error?: Error }>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        socket.write(chunk);
      });
      socket.on("error", (error) => received.resolve({ data: "", error }));
      socket.on("end", () => {
        received.resolve({ data: Buffer.concat(chunks).toString() });
        socket.end();
      });
    });
    const port = await listen(server);
    try {
      // `connect` writes, reads back the echo, then closes.
      const reply = guest.spawn([
        "/tmp/network-test",
        "connect",
        fixture.network.gateway,
        String(port),
        "guest closes first",
      ]);
      const outcome = await received.promise;
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.data, "guest closes first");
      const process = await reply;
      const [stdout, stderr, status] = await Promise.all([
        collect(process.stdout),
        collect(process.stderr),
        process.status,
      ]);
      assert.equal(decoder.decode(stderr), "");
      assert.equal(decoder.decode(stdout), "guest closes first");
      assert.deepEqual(status, { success: true, code: 0, signal: null });
      await assert_graceful(session_for(fixture, port));
    } finally {
      server.close();
    }
  });

  await t.test("aborts the signal when the guest resets", async () => {
    // Data the guest never reads makes its close an RST rather than a FIN.
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.write(pattern_bytes(64 * 1024));
    });
    const port = await listen(server);
    try {
      const result = await guest.spawn([
        "/tmp/network-test",
        "connect",
        fixture.network.gateway,
        String(port),
        "x",
      ]);
      await Promise.all([collect(result.stdout), collect(result.stderr), result.status]);
      const session = session_for(fixture, port);
      const pipes = await session.pipes;
      assert.equal(session.signal.aborted, true);
      assert.match(String(session.signal.reason), /guest reset TCP connection/);
      assert.deepEqual(
        pipes.map((pipe) => pipe.status),
        ["rejected", "rejected"],
      );
    } finally {
      server.close();
    }
  });

  await t.test("aborts the guest's sessions on a reboot and keeps its address", async () => {
    const rebooted = await fixture.spawn();
    const address = rebooted.network.address;
    // One session the guest holds open, and one that closed gracefully but
    // whose host side is still flushing.
    const held = createServer((socket) => socket.on("error", () => {}));
    const held_port = await listen(held);
    const body = pattern_bytes(1256);
    try {
      await serve(body, async (url, port) => {
        fixture.lingering.add(port);
        const fetched = await rebooted.run(["sh", "-c", `wget -qO- ${url} | wc -c`]);
        assert.equal(new TextDecoder().decode(fetched.stdout).trim(), String(body.byteLength));
        const flushing = session_for(fixture, port);
        await assert_graceful(flushing);
        void rebooted.spawn(["wget", "-qO-", `http://${fixture.network.gateway}:${held_port}/`]);
        let open: OutboundSession | undefined;
        for (let i = 0; i < 500 && !open; i++) {
          open = fixture.outbound.findLast((session) => session.target.port === held_port);
          if (!open) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(open, "the guest did not connect");

        await rebooted.machine.reboot();
        for (const session of [open, flushing]) {
          assert.equal(session.signal.aborted, true);
          assert.match(String(session.signal.reason), /guest rebooted/);
        }
        assert.equal(rebooted.network.address, address);
        // The rebooted guest has the same address and reaches the host again.
        const again = await rebooted.run(["sh", "-c", `wget -qO- ${url} | wc -c`]);
        assert.equal(new TextDecoder().decode(again.stdout).trim(), String(body.byteLength));
        const ip = await rebooted.run(["sh", "-c", "ifconfig eth0"]);
        assert.match(new TextDecoder().decode(ip.stdout), new RegExp(`inet addr:${address} `));
      });
    } finally {
      held.close();
    }
  });

  // Last: it closes the network.
  await t.test("aborts a gracefully closed session when the network closes", async () => {
    const body = pattern_bytes(1256);
    await serve(body, async (url, port) => {
      fixture.lingering.add(port);
      const result = await run(`wget -qO- ${url} | wc -c`);
      assert.equal(result.stdout.trim(), String(body.byteLength), result.stderr);
      const session = session_for(fixture, port);
      await assert_graceful(session);
      fixture.network.close();
      assert.equal(session.signal.aborted, true);
      assert.match(String(session.signal.reason), /network closed/);
    });
  });
});
