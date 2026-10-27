// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import net, {
  connect,
  createServer,
  type AddressInfo,
  type NetConnectOpts,
  type Server,
  type Socket,
} from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import type { TcpSession } from "../../src/machine/index.ts";
import { nodeNetwork, socket_readable } from "../../src/node/network.ts";

const encoder = new TextEncoder();

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** A session as the network hands it over, with the guest's ends to drive. */
function session_to(port: number, signal = new AbortController().signal) {
  const from_guest = new TransformStream<Uint8Array, Uint8Array>();
  const to_guest = new TransformStream<Uint8Array, Uint8Array>();
  const session: TcpSession = {
    target: { hostname: "127.0.0.1", port },
    readable: from_guest.readable,
    writable: to_guest.writable,
    signal,
  };
  return { session, guest: { writable: from_guest.writable, readable: to_guest.readable } };
}

describe("nodeNetwork", () => {
  it("ends the guest's stream at the peer's FIN and keeps sending to the peer", async () => {
    // The server sends a line and half-closes, then waits for the guest's
    // reply until the guest half-closes too.
    const reply = Promise.withResolvers<string>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      let received = "";
      socket.setEncoding("utf8").on("data", (chunk) => (received += chunk));
      socket.on("end", () => reply.resolve(received));
      socket.end("ready\n");
    });
    const port = await listen(server);
    try {
      const { session, guest } = session_to(port);
      const connected = nodeNetwork().connectTcp(session);
      const writer = guest.writable.getWriter();
      // The guest's stream ends while the guest can still send.
      assert.equal(await new Response(guest.readable).text(), "ready\n");
      await writer.write(encoder.encode("after ready\n"));
      await writer.close();
      await connected;
      assert.equal(await reply.promise, "after ready\n");
    } finally {
      server.close();
    }
  });

  it("delivers the peer's reply after the guest finishes sending", async () => {
    // Like an HTTP client that shuts down its write side and waits.
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      let received = "";
      socket.setEncoding("utf8").on("data", (chunk) => (received += chunk));
      socket.on("end", () => socket.end(`reply to ${received}`));
    });
    const port = await listen(server);
    try {
      const { session, guest } = session_to(port);
      const connected = nodeNetwork().connectTcp(session);
      const writer = guest.writable.getWriter();
      await writer.write(encoder.encode("request\n"));
      await writer.close();
      assert.equal(await new Response(guest.readable).text(), "reply to request\n");
      await connected;
    } finally {
      server.close();
    }
  });

  it("refuses a session that was aborted before it connected", async () => {
    let connections = 0;
    const server = createServer(() => connections++);
    const port = await listen(server);
    try {
      const abort = new AbortController();
      const reason = new Error("the guest went away");
      abort.abort(reason);
      const { session } = session_to(port, abort.signal);
      await assert.rejects(Promise.resolve(nodeNetwork().connectTcp(session)), reason);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(connections, 0);
    } finally {
      server.close();
    }
  });

  it("closes a connection that completes after its session aborted", async (t) => {
    const accepted = Promise.withResolvers<{ closed: Promise<unknown> }>();
    // Every socket, so that a regression fails rather than hangs.
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      accepted.resolve({ closed: once(socket, "close") });
    });
    const port = await listen(server);
    // The session aborts as the connection completes, before nodeNetwork
    // has seen it, and Node keeps the connection: only nodeNetwork can close
    // it.
    const abort = new AbortController();
    const reason = new Error("the guest went away");
    const create = net.createConnection;
    t.mock.method(net, "createConnection", (options: NetConnectOpts) => {
      const socket = create(options);
      sockets.push(socket);
      socket.prependOnceListener("connect", () => abort.abort(reason));
      return socket;
    });
    syncBuiltinESMExports();
    try {
      const { session } = session_to(port, abort.signal);
      await assert.rejects(
        Promise.resolve(nodeNetwork().connectTcp(session)),
        (error: Error) => error.name === "AbortError" && error.cause === reason,
      );
      const connection = await Promise.race([
        accepted.promise,
        delay(2000, undefined, { ref: false }),
      ]);
      assert.ok(connection, "the server never saw the connection");
      const open = delay(2000, "open", { ref: false });
      assert.equal(await Promise.race([connection.closed.then(() => "closed"), open]), "closed");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  });

  it("closes a connection still flushing to a peer when its session aborts", async () => {
    // The peer sends its FIN at once and never reads, so the guest's data
    // fills the socket's buffers and its write never finishes, though the
    // guest has finished sending too.
    const accepted = Promise.withResolvers<{ closed: Promise<unknown> }>();
    const sockets: Socket[] = [];
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      socket.pause();
      socket.end();
      accepted.resolve({ closed: once(socket, "close") });
    });
    const port = await listen(server);
    try {
      const abort = new AbortController();
      const { session, guest } = session_to(port, abort.signal);
      const connected = Promise.resolve(nodeNetwork().connectTcp(session));
      void connected.catch(() => {});
      const { closed } = await accepted.promise;
      // Drain the peer's (empty) side to its FIN.
      await new Response(guest.readable).arrayBuffer();
      const writer = guest.writable.getWriter();
      void writer.write(new Uint8Array(16 * 1024 * 1024)).catch(() => {});
      void writer.close().catch(() => {});
      await delay(200);
      abort.abort(new Error("the network closed"));
      const settled = await Promise.race([
        connected.then(
          () => "resolved",
          () => "rejected",
        ),
        delay(2000, "pending", { ref: false }),
      ]);
      assert.notEqual(settled, "pending");
      // Reading again, the peer sees the connection end.
      for (const socket of sockets) socket.resume();
      const open = delay(2000, "open", { ref: false });
      assert.equal(await Promise.race([closed.then(() => "closed"), open]), "closed");
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  });

  it("ignores a socket's events once its stream is cancelled", async () => {
    const server = createServer((socket) => socket.on("error", () => {}).end("data"));
    const port = await listen(server);
    try {
      const socket = connect(port, "127.0.0.1");
      await once(socket, "connect");
      // A failed destination cancels the stream and destroys the socket;
      // its close event must not close the cancelled stream.
      const closed = once(socket, "close");
      await socket_readable(socket).cancel();
      await closed;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(socket.destroyed, true);
    } finally {
      server.close();
    }
  });
});
