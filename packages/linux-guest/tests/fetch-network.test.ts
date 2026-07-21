import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { type AddressInfo } from "node:net";
import { test } from "node:test";
import {
  consoleDevice,
  createNetwork,
  entropyDevice,
  type NetworkedGuest,
  type NetworkOptions,
  spawnGuest,
  type TcpSession,
} from "../src/index.ts";
import { fetchNetwork } from "../src/fetch.ts";
import { ByteReader } from "../src/http.ts";
import { assets } from "./assets.ts";
import { closed_input, collect, console_output, pattern_bytes } from "./helpers.ts";

const decoder = new TextDecoder();

// The test server terminates plain HTTP, so map the https origin the adapter
// builds onto its loopback port. fetch overwrites Host from the target URL, so
// the reconstructed authority is preserved in a header the server can assert.
function loopback_fetch(port: number): (request: Request) => Promise<Response> {
  return (request) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("x-origin-host", url.host);
    const target = new URL(`http://127.0.0.1:${port}${url.pathname}${url.search}`);
    return globalThis.fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      duplex: "half",
    } as RequestInit);
  };
}

async function read_body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function with_guest(options: NetworkOptions, fn: (guest: NetworkedGuest) => Promise<void>) {
  const network = createNetwork(options);
  const guest = await spawnGuest({
    cpus: 1,
    network,
    assets,
    devices: [consoleDevice(closed_input(), console_output()), entropyDevice()],
  });
  const console_done = guest.machine.bootConsole.pipeTo(console_output());
  try {
    await fn(guest);
  } finally {
    network.close();
    guest.machine.close();
    await guest.machine.closed;
    await console_done;
  }
}

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

test("resolves any name and reconstructs the request over fetch", async () => {
  let seen: { method?: string; url?: string; host?: string } = {};
  const server = createServer((request, response) => {
    seen = {
      method: request.method,
      url: request.url,
      host: request.headers["x-origin-host"] as string,
    };
    response.end("hello from the server");
  });
  const port = await listen(server);
  try {
    await with_guest(fetchNetwork({ fetch: loopback_fetch(port) }), async (guest) => {
      const wget = await guest.exec(["wget", "-q", "-O", "-", "http://example.test/greeting"]);
      const [output, status] = await Promise.all([collect(wget.stdout), wget.status]);
      assert.equal(decoder.decode(output), "hello from the server");
      assert.deepEqual(status, { success: true, code: 0, signal: null });
    });
  } finally {
    server.close();
  }
  assert.equal(seen.method, "GET");
  assert.equal(seen.url, "/greeting");
  assert.equal(seen.host, "example.test");
});

test("streams a large response through with its bytes intact", async () => {
  const payload = pattern_bytes(1 << 20);
  const server = createServer((_request, response) => response.end(Buffer.from(payload)));
  const port = await listen(server);
  try {
    await with_guest(fetchNetwork({ fetch: loopback_fetch(port) }), async (guest) => {
      const wget = await guest.exec(["wget", "-q", "-O", "-", "http://example.test/blob"]);
      const [output, status] = await Promise.all([collect(wget.stdout), wget.status]);
      assert.deepEqual(output, payload);
      assert.deepEqual(status, { success: true, code: 0, signal: null });
    });
  } finally {
    server.close();
  }
});

test("forwards a POST body framed by Content-Length", async () => {
  let body: string | undefined;
  const server = createServer(async (request, response) => {
    body = (await read_body(request)).toString();
    response.end("stored");
  });
  const port = await listen(server);
  try {
    await with_guest(fetchNetwork({ fetch: loopback_fetch(port) }), async (guest) => {
      const request =
        "POST /submit HTTP/1.1\r\nHost: example.test\r\n" +
        "Content-Length: 5\r\nConnection: close\r\n\r\nhello";
      const nc = await guest.exec(["sh", "-c", `printf '${request}' | nc 198.18.0.1 80`]);
      const output = decoder.decode(await collect(nc.stdout));
      assert.match(output, /^HTTP\/1\.1 200/);
      assert.match(output, /stored$/);
    });
  } finally {
    server.close();
  }
  assert.equal(body, "hello");
});

test("answers Expect: 100-continue with an interim response", async () => {
  let body: string | undefined;
  const server = createServer(async (request, response) => {
    body = (await read_body(request)).toString();
    response.end("accepted");
  });
  const port = await listen(server);
  try {
    await with_guest(fetchNetwork({ fetch: loopback_fetch(port) }), async (guest) => {
      const request =
        "POST /expect HTTP/1.1\r\nHost: example.test\r\nExpect: 100-continue\r\n" +
        "Content-Length: 4\r\nConnection: close\r\n\r\nbody";
      const nc = await guest.exec(["sh", "-c", `printf '${request}' | nc 198.18.0.1 80`]);
      const output = decoder.decode(await collect(nc.stdout));
      assert.match(output, /HTTP\/1\.1 100 Continue/);
      assert.match(output, /HTTP\/1\.1 200/);
      assert.match(output, /accepted$/);
    });
  } finally {
    server.close();
  }
  assert.equal(body, "body");
});

test("decodes a chunked request body before forwarding", async () => {
  let body: string | undefined;
  const server = createServer(async (request, response) => {
    body = (await read_body(request)).toString();
    response.end("ok");
  });
  const port = await listen(server);
  try {
    await with_guest(fetchNetwork({ fetch: loopback_fetch(port) }), async (guest) => {
      const request =
        "POST /chunked HTTP/1.1\r\nHost: example.test\r\nTransfer-Encoding: chunked\r\n" +
        "Connection: close\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
      const nc = await guest.exec(["sh", "-c", `printf '${request}' | nc 198.18.0.1 80`]);
      const output = decoder.decode(await collect(nc.stdout));
      assert.match(output, /^HTTP\/1\.1 200/);
    });
  } finally {
    server.close();
  }
  assert.equal(body, "hello world");
});

test("serializes a 502 when fetch rejects", async () => {
  const network = fetchNetwork({
    fetch: () => Promise.reject(new Error("upstream is unreachable")),
  });
  await with_guest(network, async (guest) => {
    const request = "GET /down HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n";
    const nc = await guest.exec(["sh", "-c", `printf '${request}' | nc 198.18.0.1 80`]);
    const output = decoder.decode(await collect(nc.stdout));
    assert.match(output, /^HTTP\/1\.1 502 Bad Gateway/);
    assert.match(output, /Bad Gateway\n$/);
    assert.doesNotMatch(output, /upstream is unreachable/);
  });
});

async function adapter_request(
  network: ReturnType<typeof fetchNetwork>,
  request: string,
): Promise<string> {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const abort = new AbortController();
  const session: TcpSession = {
    target: { hostname: "198.18.0.1", port: 80 },
    readable: input.readable,
    writable: output.writable,
    signal: abort.signal,
  };
  const handled = Promise.resolve().then(() => network.connectTcp(session));
  const response = collect(output.readable);
  const writer = input.writable.getWriter();
  const written = (async () => {
    await writer.write(new TextEncoder().encode(request));
    await writer.close();
  })();
  const [, bytes] = await Promise.all([written, response, handled]);
  return decoder.decode(bytes);
}

test("fetches without ambient browser authority and strips nominated headers", async () => {
  let seen: Request | undefined;
  const network = fetchNetwork({
    fetch: (request) => {
      seen = request;
      assert.equal(request.headers.get("x-private"), null);
      return Promise.resolve(
        new Response("ok", {
          headers: { connection: "x-response-private", "x-response-private": "secret" },
        }),
      );
    },
  });
  const output = await adapter_request(
    network,
    "GET / HTTP/1.1\r\nHost: example.test\r\nConnection: x-private\r\nX-Private: secret\r\n\r\n",
  );
  assert.equal(seen?.url, "https://example.test/");
  assert.equal(seen?.credentials, "omit");
  assert.equal(seen?.redirect, "manual");
  assert.equal(seen?.referrerPolicy, "no-referrer");
  assert.doesNotMatch(output, /x-response-private/i);
});

test("accepts bodyless methods with Content-Length: 0", async () => {
  const methods: string[] = [];
  const network = fetchNetwork({
    fetch: (request) => {
      methods.push(request.method);
      return Promise.resolve(new Response());
    },
  });
  for (const method of ["GET", "HEAD"]) {
    const output = await adapter_request(
      network,
      `${method} / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 0\r\n\r\n`,
    );
    assert.match(output, /^HTTP\/1\.1 200/);
  }
  assert.deepEqual(methods, ["GET", "HEAD"]);
});

test("streams request bodies larger than the former adapter cap", async () => {
  const length = 17 * 1024 * 1024;
  let received = 0;
  const network = fetchNetwork({
    async fetch(request) {
      for await (const chunk of request.body ?? []) received += chunk.byteLength;
      return new Response("ok");
    },
  });
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const session: TcpSession = {
    target: { hostname: "198.18.0.1", port: 80 },
    readable: input.readable,
    writable: output.writable,
    signal: new AbortController().signal,
  };
  const handled = Promise.resolve().then(() => network.connectTcp(session));
  const response = collect(output.readable);
  const writer = input.writable.getWriter();
  await writer.write(
    new TextEncoder().encode(
      `POST /large HTTP/1.1\r\nHost: example.test\r\nContent-Length: ${length}\r\n\r\n`,
    ),
  );
  const chunk = new Uint8Array(1024 * 1024);
  for (let written = 0; written < length; written += chunk.byteLength) await writer.write(chunk);
  await writer.close();
  const [, bytes] = await Promise.all([handled, response]);
  assert.equal(received, length);
  assert.match(decoder.decode(bytes), /^HTTP\/1\.1 200/);
});

test("rejects Host values that can change URL structure", async () => {
  let fetched = false;
  const network = fetchNetwork({
    fetch: () => {
      fetched = true;
      return Promise.resolve(new Response("unreachable"));
    },
  });
  const output = await adapter_request(
    network,
    "GET / HTTP/1.1\r\nHost: user@example.test\r\n\r\n",
  );
  assert.match(output, /^HTTP\/1\.1 400 Bad Request/);
  assert.equal(fetched, false);
});

test("rejects ambiguous, duplicate, and non-decimal content lengths", async () => {
  let fetched = false;
  const network = fetchNetwork({
    fetch: () => {
      fetched = true;
      return new Response();
    },
  });
  for (const framing of [
    "Content-Length: 1e3\r\n",
    "Content-Length: 5\r\nContent-Length: 5\r\n",
    "Content-Length: 5\r\nTransfer-Encoding: chunked\r\n",
  ]) {
    const output = await adapter_request(
      network,
      `POST / HTTP/1.1\r\nHost: example.test\r\n${framing}\r\n`,
    );
    assert.match(output, /^HTTP\/1\.1 400 Bad Request/);
  }
  const lf_only = await adapter_request(network, "GET / HTTP/1.1\nHost: example.test\n\n");
  assert.match(lf_only, /^HTTP\/1\.1 400 Bad Request/);
  assert.equal(fetched, false);
});

test("backpressures an upstream fetch response when the guest stops reading", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(1024));
    },
  });
  const network = fetchNetwork({ fetch: () => Promise.resolve(new Response(body)) });
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const abort = new AbortController();
  const session: TcpSession = {
    target: { hostname: "198.18.0.1", port: 80 },
    readable: input.readable,
    writable: output.writable,
    signal: abort.signal,
  };
  const handled = Promise.resolve().then(() => network.connectTcp(session));
  const response = new ByteReader(output.readable);
  const response_head = response.head();
  const writer = input.writable.getWriter();
  await writer.write(new TextEncoder().encode("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n"));
  const request_closed = writer.close();
  assert.equal((await response_head)?.line, "HTTP/1.1 200 ");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(pulls <= 2, `upstream body was pulled ${pulls} times without downstream reads`);
  await response.cancel("test complete");
  await assert.rejects(handled);
  await request_closed.catch(() => {});
});

test("rejecting before first I/O refuses the pending guest connection", async () => {
  let aborted = false;
  const options: NetworkOptions = {
    resolveDns: () => Promise.resolve(["198.18.0.1"]),
    connectTcp(session) {
      session.signal.addEventListener("abort", () => (aborted = true), { once: true });
      throw new Error("refused before activation");
    },
  };
  await with_guest(options, async (guest) => {
    const nc = await guest.exec(["nc", "-w", "1", "198.18.0.1", "80"]);
    assert.equal((await nc.status).success, false);
  });
  assert.equal(aborted, true);
});
