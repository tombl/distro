// Differential test: the fetch adapter's reading of guest HTTP/1.1 traffic
// must agree with Node's own llhttp parser, which doubles as the oracle. One
// seeded corpus of generated, edge-case, and mutated requests is run through
// both; agreement rules:
//
//   - Node rejects a message -> the adapter must not forward it (it answers
//     with its own 4xx/5xx instead). A proxy that accepts what the origin
//     rejects is a request-smuggling hazard.
//   - Node accepts a well-formed message -> the adapter must forward it, and
//     the reconstructed request must equal Node's parse (after the documented
//     hop-by-hop stripping).
//   - Node accepts an out-of-contract message (lone LF, odd Host, ...) -> the
//     adapter may reject it, but must still answer cleanly.
//
// The corpus is deterministic: failures reproduce from the seed and index.
// FUZZ_SEED and FUZZ_SCALE override the defaults for deeper local runs.

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import net from "node:net";
import { type Duplex } from "node:stream";
import { test } from "node:test";
import { fetchNetwork } from "../src/fetch.ts";
import type { NetworkOptions, TcpSession } from "../src/index.ts";
import { build_request_corpus, type CorpusEntry } from "./fuzz.ts";
import { collect } from "./helpers.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const SEED = Number(process.env.FUZZ_SEED ?? "0x5eed");
const SCALE = Number(process.env.FUZZ_SCALE ?? "1");
const TIMEOUT_MS = 5000;

// Fields the adapter removes before constructing the forwarded request; the
// oracle parse is reduced the same way before comparison. Mirrors the list
// in src/http.ts.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const ALSO_STRIPPED = ["content-length", "expect", "host"];
const ERROR_STATUSES = new Set([400, 417, 501, 502]);

interface NodeParse {
  ok: boolean;
  timeout?: boolean;
  method?: string;
  url?: string;
  headers?: string[];
  body?: Uint8Array;
}

class OraclePending {
  private done = false;
  private body_complete = false;
  private request_seen = false;
  private resolve!: (result: NodeParse) => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  readonly result: Promise<NodeParse>;

  constructor() {
    this.result = new Promise((resolve) => {
      this.resolve = resolve;
    });
    this.timer = setTimeout(() => this.finish({ ok: false, timeout: true }), TIMEOUT_MS);
  }

  finish(result: NodeParse) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.resolve(result);
  }

  /** A parse error after a complete request (e.g. data past Connection: close) must not override it. */
  finishRejected() {
    if (this.request_seen) {
      // llhttp reports some failures only after delivering the request (e.g.
      // data past `Connection: close`); the message itself parsed. Only a
      // body that never completes is a rejection, so let its end event
      // settle the question first.
      setImmediate(() => {
        if (!this.body_complete) this.finish({ ok: false });
      });
      return;
    }
    this.finish({ ok: false });
  }

  onRequest(request: IncomingMessage) {
    this.request_seen = true;
    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      this.body_complete = true;
      this.finish({
        ok: true,
        method: request.method!,
        url: request.url!,
        headers: request.rawHeaders,
        body: new Uint8Array(Buffer.concat(body)),
      });
    });
  }
}

/**
 * A node:http server that parses one request per connection. Entries route
 * to connections in order; events route to entries by socket identity, so a
 * straggling close from a finished connection can never finish the next one.
 */
class Oracle {
  private readonly server = createServer();
  private readonly queue: OraclePending[] = [];
  private readonly bySocket = new Map<Duplex, OraclePending>();
  private port = 0;

  async listen() {
    this.server.on("request", (request) => {
      this.bySocket.get(request.socket)?.onRequest(request);
    });
    this.server.on("clientError", (_error, socket) => {
      this.bySocket.get(socket)?.finishRejected();
      socket.destroy();
    });
    this.server.on("connection", (socket) => {
      assert.equal(this.queue.length, 1, "oracle connections must be sequential");
      const entry = this.queue.shift()!;
      this.bySocket.set(socket, entry);
      socket.on("error", () => {});
      socket.on("close", () => {
        this.bySocket.get(socket)?.finish({ ok: false });
        this.bySocket.delete(socket);
      });
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.port = (this.server.address() as { port: number }).port;
  }

  parse(bytes: Uint8Array): Promise<NodeParse> {
    const entry = new OraclePending();
    this.queue.push(entry);
    const socket = net.connect(this.port, "127.0.0.1", () => {
      socket.write(bytes);
      socket.end();
    });
    socket.on("data", () => {});
    socket.on("error", () => {});
    return entry.result.then((result) => {
      socket.destroy();
      return result;
    });
  }

  close() {
    this.server.closeAllConnections();
    this.server.close();
  }
}

interface OursParse {
  forwarded: boolean;
  response: Uint8Array;
  method?: string;
  url?: URL;
  headers?: [string, string][];
  body?: Uint8Array;
  credentials?: string;
  redirect?: string;
  referrerPolicy?: string;
}

/** Runs the adapter's exchange over in-process streams, capturing what it forwards. */
async function ours_parse(bytes: Uint8Array): Promise<OursParse> {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const abort = new AbortController();
  const session: TcpSession = {
    target: { hostname: "198.18.0.1", port: 80 },
    readable: input.readable,
    writable: output.writable,
    signal: abort.signal,
  };
  let captured: { request: Request; body: Uint8Array } | undefined;
  const options: NetworkOptions = fetchNetwork({
    fetch: async (request) => {
      const body = request.body
        ? new Uint8Array(await new Response(request.body).arrayBuffer())
        : new Uint8Array();
      captured = { request, body };
      return new Response("ok");
    },
  });
  const writer = input.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close());
  const handled = Promise.resolve().then(() => options.connectTcp(session));
  const response = await with_timeout(
    Promise.all([written, handled, collect(output.readable)]).then(([, , bytes]) => bytes),
    `adapter stalled on input ${preview(bytes)}`,
  );
  if (captured) {
    const statuses = [...decoder.decode(response).matchAll(/^HTTP\/1\.1 (\d{3})/gm)];
    const status = statuses.at(-1)?.[1];
    return {
      forwarded: status === "200",
      response,
      method: captured.request.method,
      url: new URL(captured.request.url),
      headers: [...captured.request.headers] as [string, string][],
      body: captured.body,
      credentials: captured.request.credentials,
      redirect: captured.request.redirect,
      referrerPolicy: captured.request.referrerPolicy,
    };
  }
  return { forwarded: false, response };
}

async function with_timeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

function multimap(entries: Iterable<[string, string]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    const normalized = value.trim();
    map.set(key, map.has(key) ? `${map.get(key)}, ${normalized}` : normalized);
  }
  return map;
}

function strip_node_headers(raw: string[]): Map<string, string> {
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    pairs.push([raw[index]!, raw[index + 1]!]);
  }
  const map = multimap(pairs);
  const tokens = (map.get("connection") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase());
  for (const name of [...HOP_BY_HOP, ...tokens, ...ALSO_STRIPPED]) map.delete(name);
  return map;
}

function node_host(headers: string[]): string {
  for (let index = 0; index + 1 < headers.length; index += 2) {
    if (headers[index]!.toLowerCase() === "host") return headers[index + 1]!;
  }
  return "";
}

function assert_request_fields(entry: CorpusEntry, node: NodeParse, ours: OursParse) {
  const ours_url = ours.url!;
  const node_url = new URL(node.url!, "https://placeholder");
  assert.equal(ours.method, node.method, "method");
  assert.equal(
    ours_url.pathname + ours_url.search,
    node_url.pathname + node_url.search,
    "request target",
  );
  assert.equal(
    ours_url.hostname,
    node_host(node.headers!).replace(/:\d+$/, "").toLowerCase(),
    "authority",
  );
  assert.deepEqual(multimap(ours.headers!), strip_node_headers(node.headers!), "headers");
  assert.deepEqual(ours.body, node.body, "body");
}

function assert_clean_rejection(response: Uint8Array) {
  const statuses = [...decoder.decode(response).matchAll(/^HTTP\/1\.1 (\d{3})/gm)];
  const status = statuses.at(-1)?.[1];
  assert.ok(
    status !== undefined && ERROR_STATUSES.has(Number(status)),
    `adapter must answer with its own error status, got ${preview(response, 128)}`,
  );
}

function expects_continue(bytes: Uint8Array) {
  return decoder.decode(bytes).toLowerCase().includes("expect: 100-continue");
}

function preview(bytes: Uint8Array, limit = 160): string {
  const text = [...bytes.subarray(0, limit)]
    .map((byte) =>
      byte >= 0x20 && byte <= 0x7e
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, "0")}`,
    )
    .join("");
  return JSON.stringify(`${text}${bytes.byteLength > limit ? "…" : ""}`);
}

function describe_input(entry: CorpusEntry, index: number) {
  return `input #${index} (${entry.kind}, seed ${SEED}): ${preview(entry.bytes)}`;
}

test(`adapter agrees with node:http on the generated corpus (seed ${SEED}, scale ${SCALE})`, async (t) => {
  const oracle = new Oracle();
  await oracle.listen();
  const corpus = build_request_corpus(SEED, SCALE);
  const stats = {
    forwarded: 0,
    rejected: 0,
    stricter: 0,
    oracle_timeouts: 0,
    interim: 0,
    method_tokens: 0,
  };
  try {
    for (let index = 0; index < corpus.length; index++) {
      const entry = corpus[index]!;
      if (entry.bytes.byteLength === 0) continue;
      const node = await oracle.parse(entry.bytes);
      if (node.timeout) {
        stats.oracle_timeouts++;
        continue;
      }
      const ours = await ours_parse(entry.bytes).catch((error) => {
        assert.fail(
          `${describe_input(entry, index)}\noracle: ${node_summary(node)}\nadapter error: ${error}`,
        );
      });
      try {
        if (!node.ok) {
          if (entry.kind === "valid") {
            assert.fail("node:http rejected a well-formed request — corpus bug");
          }
          if (ours.forwarded) {
            const explained = await method_only_divergence(oracle, entry, entry.bytes, ours);
            if (!explained) {
              assert.fail("adapter forwarded a request node:http rejected");
            }
            stats.method_tokens++;
          } else {
            stats.rejected++;
            assert_clean_rejection(ours.response);
          }
        } else if (ours.forwarded) {
          stats.forwarded++;
          assert_request_fields(entry, node, ours);
          assert.equal(ours.credentials, "omit");
          assert.equal(ours.redirect, "manual");
          assert.equal(ours.referrerPolicy, "no-referrer");
          if (expects_continue(entry.bytes)) {
            stats.interim++;
            assert.match(
              decoder.decode(ours.response),
              /HTTP\/1\.1 100 Continue[\s\S]*HTTP\/1\.1 200/,
            );
          }
        } else {
          stats.stricter++;
          if (entry.kind === "valid") {
            assert.fail("adapter rejected a well-formed request node:http accepted");
          }
          assert_clean_rejection(ours.response);
        }
      } catch (error) {
        if (error instanceof assert.AssertionError) {
          assert.fail(
            `${describe_input(entry, index)}\noracle: ${node_summary(node)}\nadapter: ${ours_summary(ours)}\n${error.message}`,
          );
        }
        throw error;
      }
    }
  } finally {
    oracle.close();
  }
  t.diagnostic(
    `corpus ${corpus.length} (valid 600, edge 500, mutant 600 per scale): ` +
      `${stats.forwarded} forwarded and matched, ${stats.rejected} both rejected, ` +
      `${stats.method_tokens} token-method divergences, ${stats.stricter} stricter than node, ` +
      `${stats.interim} interim 100s, ${stats.oracle_timeouts} oracle timeouts`,
  );
  assert.ok(stats.forwarded >= corpus.length / 3, "suspiciously few requests forwarded");
  assert.ok(stats.rejected > 0, "corpus must include rejected requests");
  assert.ok(stats.oracle_timeouts === 0, "oracle must never stall");
});

/**
 * Node's llhttp only recognizes the standard method table; RFC 9110 allows
 * any token. The adapter forwards such methods and re-serializes the whole
 * message, so to explain a node rejection the method must be the only
 * difference: substituting GET must make node accept the input and parse it
 * exactly as the adapter did.
 */
async function method_only_divergence(
  oracle: Oracle,
  entry: CorpusEntry,
  bytes: Uint8Array,
  ours: OursParse,
): Promise<boolean> {
  const line_end = bytes.indexOf(0x0a);
  if (line_end === -1) return false;
  const line = decoder.decode(bytes.subarray(0, line_end)).replace(/\r$/, "");
  const match = /^([A-Za-z][A-Za-z0-9-]*) (.*)$/.exec(line);
  if (!match || match[1] !== ours.method) return false;
  const new_head = encoder.encode(`GET ${match[2]}\r`);
  const substituted = new Uint8Array(new_head.byteLength + bytes.byteLength - line_end);
  substituted.set(new_head);
  substituted.set(bytes.subarray(line_end), new_head.byteLength);
  const node = await oracle.parse(substituted);
  if (!node.ok) return false;
  assert_request_fields(entry, node, { ...ours, method: "GET" });
  return true;
}

function node_summary(node: NodeParse) {
  if (node.timeout) return "node: timed out";
  return node.ok ? `node: ${node.method} ${node.url}` : "node: rejected";
}

function ours_summary(ours: OursParse) {
  return ours.forwarded
    ? `adapter: forwarded ${ours.method} ${ours.url}`
    : `adapter: rejected (${preview(ours.response, 64)})`;
}
