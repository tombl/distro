import assert from "node:assert/strict";
import { test } from "node:test";
import { guestFetchHandler } from "../src/guest-fetch-handler.ts";
import type { GuestNetwork, NetworkedGuest, TcpConnection } from "../src/index.ts";
import { guest_test } from "./fixture.ts";
import { connect_with_retry } from "./helpers.ts";

const encoder = new TextEncoder();

// tcpsvd hands the socket to the program as stdin and stdout. Draining the
// request to EOF before replying avoids a close-with-unread-data RST that
// would race the canned response.
function serve(guest: NetworkedGuest, port: number, script: string) {
  return guest.exec(["tcpsvd", "-c", "2", "0.0.0.0", String(port), "sh", "-c", script]);
}

guest_test("guest-fetch-handler", async (t, fixture) => {
  const guest = await fixture.spawn();
  const fetch = guestFetchHandler(guest.network, { port: 8080 });

  // The `Network` overload must also typecheck, hostname supplied explicitly.
  guestFetchHandler(fixture.network, { hostname: guest.network.address, port: 80 });

  await t.test("serves a site over busybox httpd", async () => {
    await guest.fs.mkdir("/tmp/www", { recursive: true });
    await guest.fs.writeFile("/tmp/www/index.html", encoder.encode("<h1>hello</h1>\n"));
    const server = await guest.exec(["/usr/sbin/httpd", "-f", "-p", "8080", "-h", "/tmp/www"]);
    try {
      const ok = await connect_with_retry(() =>
        fetch(new Request("http://guest.example/index.html")),
      );
      assert.equal(ok.status, 200);
      assert.match(ok.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(await ok.text(), "<h1>hello</h1>\n");

      const missing = await fetch(new Request("http://guest.example/nope"));
      assert.equal(missing.status, 404);
      await missing.text();

      const head = await fetch(new Request("http://guest.example/index.html", { method: "HEAD" }));
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
    } finally {
      await server.kill();
    }
  });

  await t.test("decodes a chunked response and discards trailers", async () => {
    await guest.fs.writeFile(
      "/tmp/chunked",
      encoder.encode(
        "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\ntrailer: x-sum\r\n\r\n" +
          "5\r\nhello\r\n6\r\n world\r\n0\r\nx-sum: 42\r\n\r\n",
      ),
    );
    const server = await serve(guest, 8081, "cat >/dev/null; cat /tmp/chunked");
    const done = guestFetchHandler(guest.network, { port: 8081 });
    try {
      const res = await connect_with_retry(() => done(new Request("http://guest.example/")));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("transfer-encoding"), null);
      assert.equal(res.headers.get("x-sum"), null);
      assert.equal(await res.text(), "hello world");
    } finally {
      await server.kill();
    }
  });

  await t.test("reads an HTTP/1.0 close-delimited response", async () => {
    await guest.fs.writeFile(
      "/tmp/http10",
      encoder.encode("HTTP/1.0 200 OK\r\ncontent-type: text/plain\r\n\r\nclose delimited body"),
    );
    const server = await serve(guest, 8082, "cat >/dev/null; cat /tmp/http10");
    const done = guestFetchHandler(guest.network, { port: 8082 });
    try {
      const res = await connect_with_retry(() => done(new Request("http://guest.example/")));
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "close delimited body");
    } finally {
      await server.kill();
    }
  });

  await t.test("handles a 204 with no body", async () => {
    await guest.fs.writeFile("/tmp/no-content", encoder.encode("HTTP/1.1 204 No Content\r\n\r\n"));
    const server = await serve(guest, 8083, "cat >/dev/null; cat /tmp/no-content");
    const done = guestFetchHandler(guest.network, { port: 8083 });
    try {
      const res = await connect_with_retry(() => done(new Request("http://guest.example/")));
      assert.equal(res.status, 204);
      assert.equal(await res.text(), "");
    } finally {
      await server.kill();
    }
  });

  const canned = "HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n";

  await t.test("serializes a bodyless GET", async () => {
    await guest.fs.writeFile("/tmp/resp-get", encoder.encode(canned));
    const server = await serve(guest, 8084, "cat >/tmp/cap-get; cat /tmp/resp-get");
    const done = guestFetchHandler(guest.network, { port: 8084 });
    try {
      const res = await connect_with_retry(() =>
        done(new Request("http://guest.example/foo?bar=1")),
      );
      assert.equal(res.status, 200);
      await res.text();
      const captured = await guest.fs.readTextFile("/tmp/cap-get");
      assert.match(captured, /^GET \/foo\?bar=1 HTTP\/1\.1\r\n/);
      assert.match(captured, /\r\nhost: guest\.example\r\n/);
      assert.match(captured, /\r\nconnection: close\r\n/);
      assert.doesNotMatch(captured, /transfer-encoding|content-length/i);
      assert.ok(captured.endsWith("\r\n\r\n"));
    } finally {
      await server.kill();
    }
  });

  await t.test("serializes a POST with a content-length body", async () => {
    await guest.fs.writeFile("/tmp/resp-post", encoder.encode(canned));
    const server = await serve(guest, 8085, "cat >/tmp/cap-post; cat /tmp/resp-post");
    const done = guestFetchHandler(guest.network, { port: 8085 });
    try {
      // undici only exposes content-length when the caller sets it explicitly.
      const res = await connect_with_retry(() =>
        done(
          new Request("http://guest.example/submit", {
            method: "POST",
            body: "hello body",
            headers: { "content-length": "10" },
          }),
        ),
      );
      assert.equal(res.status, 200);
      await res.text();
      const captured = await guest.fs.readTextFile("/tmp/cap-post");
      assert.match(captured, /^POST \/submit HTTP\/1\.1\r\n/);
      assert.match(captured, /\r\ncontent-length: 10\r\n/);
      assert.doesNotMatch(captured, /transfer-encoding/i);
      assert.ok(captured.endsWith("\r\n\r\nhello body"));
    } finally {
      await server.kill();
    }
  });

  await t.test("serializes a streamed body as chunked", async () => {
    await guest.fs.writeFile("/tmp/resp-stream", encoder.encode(canned));
    const server = await serve(guest, 8086, "cat >/tmp/cap-stream; cat /tmp/resp-stream");
    const done = guestFetchHandler(guest.network, { port: 8086 });
    try {
      const res = await connect_with_retry(() => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("chunk-one"));
            controller.enqueue(encoder.encode("chunk-two"));
            controller.close();
          },
        });
        // Node requires `duplex` when streaming a request body; the lib type omits it.
        const init = { method: "POST", body, duplex: "half" } as RequestInit;
        return done(new Request("http://guest.example/stream", init));
      });
      assert.equal(res.status, 200);
      await res.text();
      const captured = await guest.fs.readTextFile("/tmp/cap-stream");
      assert.match(captured, /\r\ntransfer-encoding: chunked\r\n/);
      assert.ok(captured.endsWith("9\r\nchunk-one\r\n9\r\nchunk-two\r\n0\r\n\r\n"));
    } finally {
      await server.kill();
    }
  });

  await t.test("POST echo through httpd CGI", async () => {
    await guest.fs.mkdir("/tmp/www/cgi-bin", { recursive: true });
    // A hush CGI script: the header block, then cat streams the request body
    // (httpd frames CGI stdin by CONTENT_LENGTH) straight back as the response.
    await guest.fs.writeFile(
      "/tmp/www/cgi-bin/echo",
      encoder.encode("#!/bin/sh\necho 'Content-type: text/plain'\necho\ncat\n"),
    );
    await guest.fs.chmod("/tmp/www/cgi-bin/echo", 0o755);
    const server = await guest.exec(["/usr/sbin/httpd", "-f", "-p", "8087", "-h", "/tmp/www"]);
    const done = guestFetchHandler(guest.network, { port: 8087 });
    try {
      const res = await connect_with_retry(() =>
        done(
          new Request("http://guest.example/cgi-bin/echo", {
            method: "POST",
            body: "echo me",
            headers: { "content-length": "7" },
          }),
        ),
      );
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
      assert.equal(await res.text(), "echo me");
    } finally {
      await server.kill();
    }
  });

  await t.test("returns an early final response without finishing the upload", async () => {
    await guest.fs.writeFile(
      "/tmp/too-large",
      encoder.encode("HTTP/1.1 413 Content Too Large\r\ncontent-length: 0\r\n\r\n"),
    );
    // Exit immediately after the response without draining stdin: the complete
    // HTTP response must win over the upload write failure caused by close.
    const server = await serve(guest, 8088, "cat /tmp/too-large");
    const done = guestFetchHandler(guest.network, { port: 8088 });
    try {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      });
      const init = { method: "POST", body, duplex: "half" } as RequestInit;
      const response = await connect_with_retry(() =>
        done(new Request("http://guest.example/upload", init)),
      );
      assert.equal(response.status, 413);
      await response.body?.cancel();
    } finally {
      await server.kill();
    }
  });

  await t.test("rejects an already-aborted request before connecting", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(
      guestFetchHandler(guest.network, { port: 65535 })(
        new Request("http://guest.example/", { signal: controller.signal }),
      ),
      /cancelled/,
    );
  });
});

test("guestFetchHandler abort cancels a stalled request body", async () => {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<unknown>();
  let first = true;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (first) {
        first = false;
        controller.enqueue(new Uint8Array(1024));
        started.resolve();
      }
      return new Promise(() => {});
    },
    cancel(reason) {
      cancelled.resolve(reason);
    },
  });

  let incoming!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const address = { transport: "tcp", hostname: "192.0.2.2", port: 8080 } as const;
  const connection: TcpConnection = {
    readable: new ReadableStream({ start: (controller) => (incoming = controller) }),
    writable: new WritableStream(),
    localAddr: address,
    remoteAddr: address,
    close() {
      if (closed) return;
      closed = true;
      incoming.error(new Error("connection closed"));
    },
  };
  const network = {
    address: address.hostname,
    connect: (options: { signal?: AbortSignal }) => {
      const abort = () => connection.close();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      return Promise.resolve(connection);
    },
  } as unknown as GuestNetwork;

  const controller = new AbortController();
  const init = { method: "POST", body, duplex: "half", signal: controller.signal } as RequestInit;
  const response = guestFetchHandler(network, { port: 8080 })(new Request("http://guest/", init));
  await started.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("cancelled"));
  await assert.rejects(response, /cancelled/);
  await cancelled.promise;
  assert.equal(closed, true);
});
