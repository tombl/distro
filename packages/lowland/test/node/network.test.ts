// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Server } from "node:net";
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

  it("destroys the socket when the session aborts while connecting", async () => {
    const closed: Promise<unknown>[] = [];
    const server = createServer((socket) => {
      socket.on("error", () => {});
      closed.push(once(socket, "close"));
    });
    const port = await listen(server);
    try {
      const abort = new AbortController();
      const { session } = session_to(port, abort.signal);
      const connected = Promise.resolve(nodeNetwork().connectTcp(session));
      abort.abort(new Error("the guest went away"));
      await assert.rejects(connected);
      // A connection Node established anyway is closed, not leaked.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await Promise.all(closed);
    } finally {
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
