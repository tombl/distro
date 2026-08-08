import {
  ByteReader,
  chunked_body,
  chunked_encoder,
  declared_body,
  declared_raw_body,
  eof_body,
  fixed_body,
  type HttpHead,
  parse_status_line,
  serialize_head,
  strip_hop_by_hop,
} from "./http.ts";
import type { GuestNetwork, Network, TcpConnection } from "./network.ts";

/**
 * Turns a listener inside a guest into a fetch-like handler: each call opens
 * one connection, streams the request in, and resolves to a streaming
 * `Response`. One connect per call with a single attempt — a listener that is
 * not up yet rejects, and retrying is the caller's concern.
 */
export function guestFetchHandler(
  network: GuestNetwork,
  options: { port: number },
): (request: Request) => Promise<Response>;
export function guestFetchHandler(
  network: Network,
  options: { hostname: string; port: number },
): (request: Request) => Promise<Response>;
export function guestFetchHandler(
  network: GuestNetwork | Network,
  options: { hostname?: string; port: number },
): (request: Request) => Promise<Response> {
  return async (request) => {
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    strip_hop_by_hop(headers, ["host"]);
    // The real public host so absolute links the server generates stay correct.
    headers.set("host", url.host);
    headers.set("connection", "close");
    const framing = declared_body(headers);
    if (request.body && framing === undefined) {
      headers.set("transfer-encoding", "chunked");
    }

    const connection = await (
      network.connect as (options: {
        hostname?: string;
        port: number;
        signal?: AbortSignal;
      }) => Promise<TcpConnection>
    )({ ...options, signal: request.signal });
    let request_reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let sent: Promise<void> | undefined;
    try {
      const writer = connection.writable.getWriter();
      const line = `${request.method} ${url.pathname}${url.search} HTTP/1.1`;
      const reader = new ByteReader(connection.readable);
      let responded = false;
      let send_error: unknown;
      sent = send_request(
        writer,
        serialize_head(line, headers),
        request.body,
        typeof framing === "number" ? framing : undefined,
        framing === undefined && request.body !== null,
        (value) => {
          request_reader = value;
          if (responded && value)
            void value.cancel("guest responded before upload completed").catch(() => {});
        },
      );
      // Keep parsing concurrently. An already-parsed final response is
      // authoritative even when the server closes without reading the upload.
      void sent.catch((error) => {
        send_error = error;
        if (!responded) connection.close();
      });
      let head: Awaited<ReturnType<ByteReader["head"]>>;
      try {
        head = await reader.head();
      } catch (error) {
        throw send_error ?? error;
      }
      let parsed = head && parse_status_line(head.line);
      while (head && parsed!.status < 200 && parsed!.status !== 101) {
        try {
          head = await reader.head();
        } catch (error) {
          throw send_error ?? error;
        }
        parsed = head && parse_status_line(head.line);
      }
      if (!head) throw new Error("guest closed the connection before responding");
      const { status, text } = parsed!;
      if (status === 101) throw new Error("HTTP protocol upgrades are not supported");

      // A server may reject an upload without consuming it. Stop pulling new
      // body bytes; any write already waiting on the TCP window is released
      // when the response body closes the connection.
      responded = true;
      if (request_reader)
        void request_reader.cancel("guest responded before upload completed").catch(() => {});

      const exposed = new Headers(head.headers);
      strip_hop_by_hop(exposed);
      const body = response_body(request.method, status, head, reader, connection);
      return new Response(body, {
        status,
        statusText: text,
        headers: exposed,
      });
    } catch (error) {
      // Ownership either transfers to the returned Response or ends here.
      connection.close();
      await request_reader?.cancel(error).catch(() => {});
      await sent?.catch(() => {});
      if (request.signal.aborted) throw request.signal.reason;
      throw error;
    }
  };
}

function response_body(
  method: string,
  status: number,
  head: HttpHead,
  reader: ByteReader,
  connection: TcpConnection,
): ReadableStream<Uint8Array> | null {
  if (method === "HEAD" || status === 204 || status === 205 || status === 304) {
    connection.close();
    return null;
  }
  const declared = declared_raw_body(head);
  const body =
    declared === "chunked"
      ? chunked_body(reader)
      : declared === undefined
        ? eof_body(reader)
        : fixed_body(reader, declared);
  return closing(body, connection);
}

/** Wraps a body so the connection closes once it ends, errors, or is cancelled. */
function closing(
  body: ReadableStream<Uint8Array>,
  connection: TcpConnection,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const close = () => connection.close();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          close();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        close();
        throw error;
      }
    },
    cancel(reason) {
      close();
      return reader.cancel(reason);
    },
  });
}

async function send_request(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  head: Uint8Array,
  body: ReadableStream<Uint8Array> | null,
  declared: number | undefined,
  chunked: boolean,
  set_reader: (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => void,
) {
  await writer.write(head);
  let written = 0;
  if (body) {
    const encoded = chunked ? body.pipeThrough(chunked_encoder()) : body;
    const reader = encoded.getReader();
    set_reader(reader);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (declared !== undefined && written > declared) {
          throw new Error("request body exceeds content-length");
        }
        await writer.write(value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
      set_reader(undefined);
    }
  }
  if (declared !== undefined && written !== declared) {
    throw new Error("request body does not match content-length");
  }
  // Half-close: the guest sees FIN after the complete request.
  await writer.close();
}
