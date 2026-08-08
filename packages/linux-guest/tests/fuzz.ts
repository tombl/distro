// Deterministic corpus generation for the HTTP differential and property
// tests. Everything is seeded so a failing case reproduces from the seed and
// index alone; the tests never depend on ambient randomness.

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, options: readonly T[]): T {
  return options[Math.floor(random() * options.length)]!;
}

export function int(random: () => number, min: number, max: number) {
  return min + Math.floor(random() * (max - min + 1));
}

/** Random bytes over a few distinct byte distributions. */
export function random_bytes(random: () => number, length: number): Uint8Array {
  const mode = Math.floor(random() * 4);
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    switch (mode) {
      case 0:
        bytes[index] = int(random, 0, 255);
        break;
      case 1:
        bytes[index] = int(random, 0, 0x0f);
        break;
      case 2:
        bytes[index] = index & 0xff;
        break;
      case 3:
        bytes[index] = pick(random, [0, 0x0a, 0x0d, 0x09, 0x20, 0x2c]);
        break;
    }
  }
  return bytes;
}

/** Splits `bytes` into random-size pieces, for feeding streams incrementally. */
export function split_bytes(random: () => number, bytes: Uint8Array): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const length = int(random, 1, Math.max(1, bytes.byteLength - offset));
    pieces.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return pieces;
}

const HEADER_NAMES = [
  "Accept",
  "Accept-Encoding",
  "Cache-Control",
  "Content-Type",
  "User-Agent",
  "X-Request-ID",
  "X-Custom-Header",
];

const HEADER_VALUES = [
  "text/html",
  "text/plain; charset=utf-8",
  "application/json",
  "gzip, deflate",
  "no-cache",
  "test-agent/1.0",
  "a1b2c3d4",
  "some value with spaces",
];

const HOSTS = ["example.test", "www.example.test", "api.example.net", "cdn.example.org"];

const TARGETS = [
  "/",
  "/index.html",
  "/api/v1/items?page=2",
  "/a/b/c/d",
  "/search?q=hello+world&n=10",
  "/favicon.ico",
];

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const CRLF = "\r\n";

/**
 * Grammar-generated chunked transfer coding for `payload`: random chunk
 * sizes, and optionally extensions, uppercase sizes, and trailer fields.
 */
export function chunked_frame(
  random: () => number,
  payload: Uint8Array,
  options: { uppercase?: boolean; trailers?: boolean; extensions?: boolean } = {},
): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (offset < payload.byteLength) {
    const length = int(random, 1, Math.max(1, payload.byteLength - offset));
    let size = length.toString(16);
    if (options.uppercase) size = size.toUpperCase();
    if (options.extensions && random() < 0.3) size += `;ext=${int(random, 0, 9)}`;
    parts.push(encoder.encode(`${size}\r\n`));
    parts.push(payload.subarray(offset, offset + length));
    parts.push(encoder.encode("\r\n"));
    offset += length;
  }
  parts.push(encoder.encode("0\r\n"));
  if (options.trailers && random() < 0.5) parts.push(encoder.encode("x-trailer: value\r\n"));
  parts.push(encoder.encode("\r\n"));
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    bytes.set(part, position);
    position += part.byteLength;
  }
  return bytes;
}

/**
 * A request both Node's parser and the fetch adapter must accept: strict
 * CRLF, exactly one clean Host, well-formed framing, no upgrades.
 */
export function valid_request(random: () => number): Uint8Array {
  const method = pick(random, METHODS);
  const with_body = method !== "GET" && method !== "HEAD" && random() < 0.6;
  const body = with_body
    ? random_bytes(random, pick(random, [1, 5, 100, 1024, 16 * 1024]))
    : new Uint8Array();
  const chunked = with_body && random() < 0.5;
  const expect = with_body && !chunked && random() < 0.15;
  const connection = pick(random, ["close", "close", "x-private"]);
  const headers = [
    `Host: ${pick(random, HOSTS)}`,
    `Connection: ${connection}`,
    "User-Agent: fuzz-agent/1.0",
  ];
  if (connection === "x-private") headers.push("X-Private: secret");
  const extra = new Set<string>();
  for (let count = int(random, 0, 3); count > 0; count--) {
    const name = pick(random, HEADER_NAMES);
    if (extra.has(name)) continue;
    extra.add(name);
    headers.push(`${name}: ${pick(random, HEADER_VALUES)}`);
  }
  if (chunked) headers.push("Transfer-Encoding: chunked");
  else if (with_body || method !== "GET") headers.push(`Content-Length: ${body.byteLength}`);
  else headers.push("Content-Length: 0");
  if (expect) headers.push("Expect: 100-continue");
  const head = `${method} ${pick(random, TARGETS)} HTTP/1.1${CRLF}${headers.join(CRLF)}${CRLF}${CRLF}`;
  const encoder = new TextEncoder();
  const head_bytes = encoder.encode(head);
  const body_bytes = chunked ? chunked_frame(random, body) : body;
  const bytes = new Uint8Array(head_bytes.byteLength + body_bytes.byteLength);
  bytes.set(head_bytes);
  bytes.set(body_bytes, head_bytes.byteLength);
  return bytes;
}

const WEIRD_HOSTS = [
  "user@example.test",
  "EXAMPLE.TEST",
  "example.test:8080",
  "example.test/evil",
  "a b.test",
  "",
  "exa\tmple.test",
  "example.test\\path",
  "exam ple.test",
  "example.test?query",
];

const EVIL_FRAMING = [
  "Content-Length: +5",
  "Content-Length:  5",
  "Content-Length: 0x10",
  "Content-Length: 1e3",
  "Content-Length: -5",
  "Content-Length: 99999999999999999999",
  "Content-Length: 5\r\nContent-Length: 5",
  "Content-Length: 5\r\nContent-Length: 6",
  "Content-Length: 5\r\nTransfer-Encoding: chunked",
  "Transfer-Encoding: gzip",
  "Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked",
];

const WEIRD_TARGETS = ["/a\\b", "/hash#frag", "/space here", "*", "http://example.test/path"];

const WEIRD_LINES = ["GET / HTTP/1.0", "get / HTTP/1.1", "GET / HTTP/2.0"];

/**
 * A request outside the adapter's strict contract: Node's parser may accept
 * it, so the differential only demands rejection agreement and safety.
 */
export function edge_request(random: () => number): Uint8Array {
  const encoder = new TextEncoder();
  const mode = int(random, 0, 10);
  const host = pick(random, WEIRD_HOSTS);
  switch (mode) {
    case 0:
      return encoder.encode(
        `GET / HTTP/1.1${CRLF}Host: ${host}${CRLF}Connection: keep-alive${CRLF}${CRLF}`,
      );
    case 1:
      return encoder.encode(
        `GET / HTTP/1.1${CRLF}Host: example.test${CRLF}Upgrade: websocket${CRLF}Connection: Upgrade${CRLF}${CRLF}`,
      );
    case 2:
      return encoder.encode(
        `POST / HTTP/1.1${CRLF}Host: example.test${CRLF}Expect: 100-nonsense${CRLF}Content-Length: 5${CRLF}${CRLF}hello`,
      );
    case 3:
      return encoder.encode(
        `POST / HTTP/1.1${CRLF}Host: example.test${CRLF}Expect: 100-continue${CRLF}Content-Length: 5${CRLF}${CRLF}hello`,
      );
    case 4:
      return encoder.encode(
        `POST / HTTP/1.1${CRLF}Host: example.test${CRLF}${pick(random, EVIL_FRAMING)}${CRLF}${CRLF}hello`,
      );
    case 5:
      return encoder.encode(`GET / HTTP/1.1\nHost: example.test\n\n`);
    case 6:
      return encoder.encode(`GET / HTTP/1.1\r\nHost: example.test\n\n`);
    case 7:
      return encoder.encode(`GET ${pick(random, WEIRD_TARGETS)} HTTP/1.1${CRLF}Host: example.test${CRLF}${CRLF}`);
    case 8:
      return encoder.encode(`${pick(random, WEIRD_LINES)}${CRLF}Host: example.test${CRLF}${CRLF}`);
    case 9:
      return encoder.encode(
        `CONNECT ${pick(random, ["example.test:443", "/tunnel"])} HTTP/1.1${CRLF}Host: example.test${CRLF}${CRLF}`,
      );
    default:
      return encoder.encode(
        `GET / HTTP/1.1${CRLF}Host: ${host}${CRLF}X-Dup: a${CRLF}X-Dup: b${CRLF}${CRLF}`,
      );
  }
}

/** Byte-level mutations of a valid request. */
export function mutant(random: () => number, base: Uint8Array): Uint8Array {
  const bytes = base.slice();
  const ops = int(random, 1, 3);
  for (let count = 0; count < ops; count++) {
    switch (int(random, 0, 5)) {
      case 0: {
        const index = int(random, 0, bytes.byteLength - 1);
        bytes[index]! ^= 1 << int(random, 0, 7);
        break;
      }
      case 1: {
        const index = int(random, 0, bytes.byteLength - 1);
        bytes.set(bytes.subarray(index + 1));
        break;
      }
      case 2: {
        const index = int(random, 0, bytes.byteLength);
        const inserted = new Uint8Array(bytes.byteLength + 1);
        inserted.set(bytes.subarray(0, index));
        inserted[index] = pick(random, [0x0d, 0x0a, 0x20, 0x3a, 0x41, 0x00, 0x7f]);
        inserted.set(bytes.subarray(index), index + 1);
        return inserted;
      }
      case 3: {
        const marker = bytes.indexOf(0x0d, int(random, 0, Math.max(0, bytes.byteLength - 1)));
        if (marker !== -1) bytes[marker] = 0x0a;
        break;
      }
      case 4: {
        const index = int(random, 0, Math.max(0, bytes.byteLength - 1));
        const before = bytes.subarray(0, index);
        const after = bytes.subarray(index);
        const doubled = new Uint8Array(before.byteLength + after.byteLength + 1);
        doubled.set(before);
        doubled.set([bytes[index]!], before.byteLength);
        doubled.set(after, before.byteLength + 1);
        return doubled;
      }
      case 5: {
        const index = int(random, 0, Math.max(0, bytes.byteLength - 1));
        const before = bytes.subarray(0, index);
        const rest = bytes.subarray(index + 1);
        const swapped = new Uint8Array(bytes.byteLength);
        swapped.set(rest);
        swapped.set(before, rest.byteLength);
        return swapped;
      }
    }
  }
  return bytes;
}

export interface CorpusEntry {
  readonly bytes: Uint8Array;
  /** "valid" requests must be accepted and parsed identically by both sides. */
  readonly kind: "valid" | "edge" | "mutant";
}

export function build_request_corpus(seed: number, scale: number): CorpusEntry[] {
  const random = mulberry32(seed);
  const corpus: CorpusEntry[] = [];
  for (let count = 0; count < 600 * scale; count++) {
    corpus.push({ bytes: valid_request(random), kind: "valid" });
  }
  for (let count = 0; count < 500 * scale; count++) {
    corpus.push({ bytes: edge_request(random), kind: "edge" });
  }
  for (let count = 0; count < 600 * scale; count++) {
    corpus.push({ bytes: mutant(random, valid_request(random)), kind: "mutant" });
  }
  return corpus;
}

/** Random header maps for serialize/parse round-trip properties. */
export function random_headers(random: () => number): Headers {
  const headers = new Headers();
  for (let count = int(random, 1, 6); count > 0; count--) {
    const name = pick(random, [...HEADER_NAMES, "X-Spaces", "Content-Length"]);
    const value = pick(random, [...HEADER_VALUES, " padded value ", "tab\there", "caf\u00e9"]);
    headers.set(name, value);
  }
  return headers;
}
