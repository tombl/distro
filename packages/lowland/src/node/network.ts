// SPDX-License-Identifier: MIT

import { resolve4 } from "node:dns/promises";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { Writable } from "node:stream";
import type { NetworkOptions } from "../machine/network/network.ts";

/**
 * @internal The bytes a socket receives, ending at the remote FIN while the
 * socket stays open for writing. Node's own `Duplex.toWeb()` waits for both
 * directions to close before Node 24.20 and 26.7.
 */
export function socket_readable(socket: Socket): ReadableStream<Uint8Array> {
  // Set once the stream is closed, errored, or cancelled, after which the
  // socket's remaining events must not touch it.
  let done = false;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          if (error) controller.error(error);
          else controller.close();
        };
        socket.on("data", (chunk: Buffer) => {
          if (done) return;
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          if ((controller.desiredSize ?? 0) <= 0) socket.pause();
        });
        socket.once("end", () => finish());
        socket.once("error", (error) => finish(error));
        socket.once("close", () => finish());
      },
      pull() {
        socket.resume();
      },
      cancel() {
        done = true;
        socket.destroy();
      },
    },
    { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
  );
}

/**
 * The host's network, as the adapters for `createNetwork()` from
 * `lowland/machine`. Guest TCP connections go out through the host's
 * sockets, DNS queries through its resolver, and the gateway address,
 * `192.0.2.1`, reaches the host's loopback. A guest reaches whatever this
 * process can.
 *
 * Each direction of a connection closes on its own, so a guest that
 * half-closes, like an HTTP client that shuts down its write side and waits
 * for the reply, still gets the reply, and a host peer that finishes
 * sending first still gets the rest of what the guest sends.
 *
 * @example
 * ```ts
 * import { createNetwork } from "lowland/machine";
 * import { nodeNetwork } from "lowland/node";
 *
 * using network = createNetwork(nodeNetwork());
 * ```
 */
export function nodeNetwork(): Required<NetworkOptions> {
  return {
    async connectTcp(session) {
      session.signal.throwIfAborted();
      // Half-open, so a peer that finishes sending still gets the rest of
      // what the guest sends.
      const socket = createConnection({
        host: session.target.hostname,
        port: session.target.port,
        signal: session.signal,
        allowHalfOpen: true,
      });
      try {
        await once(socket, "connect");
        await Promise.all([
          session.readable.pipeTo(Writable.toWeb(socket) as WritableStream<Uint8Array>),
          socket_readable(socket).pipeTo(session.writable),
        ]);
      } finally {
        // An abort can win the race with the connection, which Node then
        // still establishes.
        socket.destroy();
      }
    },
    resolveDns: resolve4,
  };
}
