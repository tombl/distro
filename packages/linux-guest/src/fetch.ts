// Fetch-backed outbound HTTP. Guests speak plaintext HTTP/1; the adapter
// intentionally translates it to HTTPS Fetch. The supplied callback owns all
// platform routing and policy.

import {
  ByteReader,
  chunked_body,
  declared_raw_body,
  fixed_body,
  parse_request_line,
  serialize_head,
  strip_hop_by_hop,
} from "./http.ts";
import type { NetworkOptions, TcpSession } from "./network.ts";

const PLACEHOLDER_ADDRESS = "198.18.0.1";
const encoder = new TextEncoder();
const CONTINUE = encoder.encode("HTTP/1.1 100 Continue\r\n\r\n");
const BAD_REQUEST = response_bytes("HTTP/1.1 400 Bad Request", "Bad Request\n");
const EXPECTATION_FAILED = response_bytes(
  "HTTP/1.1 417 Expectation Failed",
  "Expectation Failed\n",
);
const NOT_IMPLEMENTED = response_bytes("HTTP/1.1 501 Not Implemented", "Not Implemented\n");
const BAD_GATEWAY = response_bytes("HTTP/1.1 502 Bad Gateway", "Bad Gateway\n");

function response_bytes(status: string, text: string) {
  const body = encoder.encode(text);
  const head = serialize_head(
    status,
    new Headers({
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(body.byteLength),
      connection: "close",
    }),
  );
  const bytes = new Uint8Array(head.byteLength + body.byteLength);
  bytes.set(head);
  bytes.set(body, head.byteLength);
  return bytes;
}

function request_url(host: string, target: string) {
  if (/[/\\?#@\s\u0000-\u001f\u007f]/.test(host)) throw new Error("invalid HTTP Host");
  const origin = new URL(`https://${host}/`);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
    throw new Error("invalid HTTP Host");
  const url = new URL(target, origin);
  if (url.origin !== origin.origin) throw new Error("invalid HTTP request target");
  return url;
}

async function exchange(
  session: TcpSession,
  do_fetch: (request: Request) => Response | PromiseLike<Response>,
) {
  // This is a gateway request boundary: reject lone-LF syntax rather than
  // allowing different HTTP parsers to disagree about message boundaries.
  const reader = new ByteReader(session.readable, { strictCrlf: true });
  const writer = session.writable.getWriter();
  const abort = new AbortController();
  const stop = () => abort.abort(session.signal.reason);
  session.signal.addEventListener("abort", stop, { once: true });
  if (session.signal.aborted) stop();
  let final_output_started = false;
  let response_reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  async function error_response(response: Uint8Array) {
    final_output_started = true;
    await writer.write(response);
    await writer.close();
  }
  try {
    try {
      const head = await reader.head();
      if (!head) return;
      const { method, target } = parse_request_line(head.line);
      if (method === "CONNECT" || head.headers.has("upgrade")) {
        await error_response(NOT_IMPLEMENTED);
        return;
      }
      const hosts = head.rawHeaders.filter(([name]) => name.toLowerCase() === "host");
      if (hosts.length !== 1) throw new Error("HTTP request requires one Host header");
      const framing = declared_raw_body(head);
      const expectation = (head.headers.get("expect") ?? "").toLowerCase();
      if (expectation !== "" && expectation !== "100-continue") {
        await error_response(EXPECTATION_FAILED);
        return;
      }
      if (expectation === "100-continue") {
        await writer.write(CONTINUE);
      }
      const headers = new Headers(head.headers);
      strip_hop_by_hop(headers, ["expect", "host", "content-length"]);
      const body =
        framing === undefined || framing === 0
          ? undefined
          : framing === "chunked"
            ? chunked_body(reader)
            : fixed_body(reader, framing);
      if ((method === "GET" || method === "HEAD") && body) {
        throw new Error(`${method} request cannot carry a Fetch body`);
      }
      const request = new Request(request_url(hosts[0]![1], target), {
        method,
        headers,
        body,
        // Required by Fetch implementations that support streaming uploads.
        ...(body ? { duplex: "half" } : {}),
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: abort.signal,
      } as RequestInit);
      let response: Response;
      try {
        response = await do_fetch(request);
      } catch (error) {
        if (abort.signal.aborted) throw error;
        if (final_output_started) throw error;
        await error_response(BAD_GATEWAY);
        return;
      }
      if (response.status < 200 || response.status > 599) {
        await error_response(BAD_GATEWAY);
        return;
      }
      const out = new Headers(response.headers);
      strip_hop_by_hop(out, ["content-encoding", "content-length"]);
      out.set("connection", "close");
      final_output_started = true;
      await writer.write(serialize_head(`HTTP/1.1 ${response.status} ${response.statusText}`, out));
      if (
        response.body &&
        method !== "HEAD" &&
        response.status !== 204 &&
        response.status !== 205 &&
        response.status !== 304
      ) {
        response_reader = response.body.getReader();
        for (;;) {
          const { value, done } = await response_reader.read();
          if (done) break;
          await writer.write(value);
        }
      }
      await writer.close();
    } catch (error) {
      if (final_output_started) throw error;
      await error_response(BAD_REQUEST);
    }
  } finally {
    session.signal.removeEventListener("abort", stop);
    abort.abort("HTTP exchange complete");
    await response_reader?.cancel("HTTP exchange complete").catch(() => {});
    response_reader?.releaseLock();
    await reader.cancel("HTTP exchange complete").catch(() => {});
    reader.detach();
    writer.releaseLock();
  }
}

/**
 * Creates networking that translates one plaintext guest HTTP/1 exchange per
 * TCP connection into an HTTPS `Request`. The required callback controls the
 * Fetch implementation and its platform policy; ambient `fetch` is never used.
 */
export function fetchNetwork(options: {
  fetch(request: Request): Response | PromiseLike<Response>;
}): NetworkOptions {
  return {
    resolveDns: () => Promise.resolve([PLACEHOLDER_ADDRESS]),
    connectTcp: (session) => exchange(session, options.fetch),
  };
}
