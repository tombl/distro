// Property tests over the pure HTTP layer in src/http.ts: round-trips and
// grammar-based generation cover far more byte sequences than hand-written
// cases, and malformed inputs must reject rather than hang or crash.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ByteReader,
  chunked_body,
  chunked_encoder,
  declared_body,
  declared_raw_body,
  fixed_body,
  parse_request_line,
  parse_status_line,
  serialize_head,
  strip_hop_by_hop,
} from "../src/http.ts";
import { chunked_frame, int, mulberry32, random_bytes, random_headers, split_bytes } from "./fuzz.ts";
import { collect } from "./helpers.ts";

const encoder = new TextEncoder();

function source(bytes: Uint8Array, pieces: Uint8Array[] = [bytes]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const piece of pieces) {
        controller.enqueue(piece);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      controller.close();
    },
  });
}

test("chunked encode/decode is an identity", async () => {
  const random = mulberry32(0xfeed);
  for (const length of [0, 1, 17, 4096, 65536]) {
    for (let count = 0; count < 4; count++) {
      const payload = random_bytes(random, length);
      const encoded = new ReadableStream({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      }).pipeThrough(chunked_encoder());
      const decoded = chunked_body(new ByteReader(encoded));
      assert.deepEqual(await collect(decoded), payload);
    }
  }
});

test("grammar-generated chunked frames decode to their payload", async () => {
  const random = mulberry32(0xc0ffee);
  for (let count = 0; count < 40; count++) {
    const payload = random_bytes(random, int(random, 0, 32768));
    const frame = chunked_frame(random, payload, {
      uppercase: random() < 0.5,
      trailers: random() < 0.5,
      extensions: random() < 0.5,
    });
    const decoded = chunked_body(new ByteReader(source(frame, split_bytes(random, frame))));
    assert.deepEqual(await collect(decoded), payload);
  }
});

test("chunked decoder rejects malformed frames", async () => {
  const cases = [
    "zz\r\npayload\r\n0\r\n\r\n",
    "-1\r\npayload\r\n0\r\n\r\n",
    "5\r\nhel",
    "5\r\nhello\r\nzz\r\nx\r\n0\r\n\r\n",
    "10000000000000000\r\nx",
    "5\r\nhello",
    "0\r\n",
    "5\r\nhello\r\n0\r\n",
  ];
  for (const text of cases) {
    await assert.rejects(collect(chunked_body(new ByteReader(source(encoder.encode(text))))));
  }
});

test("serialized heads parse back to the same headers", async () => {
  const random = mulberry32(0x1234);
  for (let count = 0; count < 50; count++) {
    const headers = random_headers(random);
    const line = "GET /a/b?q=1 HTTP/1.1";
    const head = await new ByteReader(source(serialize_head(line, headers))).head();
    assert.ok(head);
    assert.equal(head.line, line);
    const expected = new Map<string, string>();
    for (const [name, value] of headers) expected.set(name.toLowerCase(), value.trim());
    const actual = new Map(head.rawHeaders.map(([name, value]) => [name.toLowerCase(), value]));
    assert.deepEqual(actual, expected);
  }
});

test("request and status lines parse strictly", () => {
  const requests: [string, { method: string; target: string }][] = [
    ["GET / HTTP/1.1", { method: "GET", target: "/" }],
    ["POST /a?b=1 HTTP/1.0", { method: "POST", target: "/a?b=1" }],
    ["DELETE /x/y HTTP/1.1", { method: "DELETE", target: "/x/y" }],
  ];
  for (const [line, expected] of requests) {
    assert.deepEqual(parse_request_line(line), expected);
  }
  for (const line of [
    "get / HTTP/1.1",
    "GET  HTTP/1.1",
    "GET / HTTP/2.0",
    "GET * HTTP/1.1",
    "GET http://x/ HTTP/1.1",
    "GET / HTTP/1.1 extra",
  ]) {
    assert.throws(() => parse_request_line(line));
  }
  const statuses: [string, { status: number; text: string }][] = [
    ["HTTP/1.1 200 OK", { status: 200, text: "OK" }],
    ["HTTP/1.0 404 Not Found", { status: 404, text: "Not Found" }],
    ["HTTP/1.1 204 ", { status: 204, text: "" }],
  ];
  for (const [line, expected] of statuses) {
    assert.deepEqual(parse_status_line(line), expected);
  }
  for (const line of ["HTTP/1.1 20 OK", "HTTP/1.1 2000 OK", "HTTP/2.0 200 OK", "HTTP/1.1 abc OK"]) {
    assert.throws(() => parse_status_line(line));
  }
});

test("declared body framing follows one obvious rule", async () => {
  const with_headers = (...pairs: [string, string][]) => {
    const headers = new Headers();
    for (const [name, value] of pairs) headers.append(name, value);
    return headers;
  };
  assert.equal(declared_body(with_headers(["content-length", "5"])), 5);
  assert.equal(declared_body(with_headers(["content-length", "0"])), 0);
  assert.equal(declared_body(with_headers()), undefined);
  assert.equal(declared_body(with_headers(["transfer-encoding", "chunked"])), "chunked");
  for (const pairs of [
    [["content-length", "5"], ["transfer-encoding", "chunked"]],
    [["transfer-encoding", "gzip"]],
    [["content-length", "1e3"]],
    [["content-length", "18446744073709551616"]],
    [["content-length", "-1"]],
  ]) {
    assert.throws(() => declared_body(with_headers(...(pairs as [string, string][]))));
  }
  // Duplicate framing must be rejected on the raw wire fields, before the
  // Headers class can combine them.
  const head = await new ByteReader(
    source(encoder.encode("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello")),
  ).head();
  assert.ok(head);
  assert.throws(() => declared_raw_body(head));
});

test("fixed bodies deliver exactly the declared bytes", async () => {
  const random = mulberry32(0xbeef);
  for (let count = 0; count < 10; count++) {
    const length = int(random, 0, 8192);
    const payload = random_bytes(random, length);
    const body = fixed_body(new ByteReader(source(payload, split_bytes(random, payload))), length);
    assert.deepEqual(await collect(body), payload);
  }
  const short = fixed_body(new ByteReader(source(random_bytes(random, 3))), 5);
  await assert.rejects(collect(short));
});

test("ByteReader enforces its head and line limits", async () => {
  const big_head = encoder.encode(`GET / HTTP/1.1\r\nX-Junk: ${"a".repeat(70000)}\r\n\r\n`);
  await assert.rejects(new ByteReader(source(big_head)).head(), /HTTP head too large/);
  const long_line = encoder.encode(`GET / HTTP/1.1\r\nX-Junk: ${"a".repeat(9000)}\r\n\r\n`);
  const reader = new ByteReader(source(long_line));
  assert.equal(await reader.line(), "GET / HTTP/1.1");
  await assert.rejects(reader.line(), /HTTP line too long/);
});

test("strip_hop_by_hop removes connection-scoped fields", () => {
  const headers = new Headers({
    connection: "x-private, keep-alive",
    "x-private": "secret",
    "keep-alive": "timeout=5",
    te: "trailers",
    "transfer-encoding": "chunked",
    upgrade: "h2c",
    "x-keep": "yes",
  });
  strip_hop_by_hop(headers);
  for (const name of ["connection", "x-private", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]) {
    assert.equal(headers.get(name), null);
  }
  assert.equal(headers.get("x-keep"), "yes");
  const bad = new Headers({ connection: "bad token!" });
  assert.throws(() => strip_hop_by_hop(bad));
});

test("malformed heads reject; empty input ends cleanly", async () => {
  assert.equal(await new ByteReader(source(new Uint8Array())).head(), undefined);
  for (const text of [
    "GET / HTTP/1.1\r\nX Bad: v\r\n\r\n",
    "GET / HTTP/1.1\r\nHost x\r\n\r\n",
    "GET / HTTP/1.1\r\n: value\r\n\r\n",
    "GET / HTTP/1.1\r\nHost: x",
  ]) {
    await assert.rejects(new ByteReader(source(encoder.encode(text))).head());
  }
  await assert.rejects(
    new ByteReader(source(encoder.encode("GET / HTTP/1.1\n\r\n\r\n")), { strictCrlf: true }).head(),
    /HTTP requires CRLF/,
  );
  // A truncated body rejects once the declared length is read.
  await assert.rejects(collect(fixed_body(new ByteReader(source(encoder.encode("he"))), 5)));
});
