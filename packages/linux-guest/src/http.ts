// HTTP/1.1 message primitives shared by the fetch adapters. This is not a
// general HTTP implementation: each adapter controls one end of its
// conversation, so only the grammar a well-behaved peer produces is accepted.

const MAX_HEAD_BYTES = 65536;
const MAX_LINE_BYTES = 8192;
const MAX_TRAILER_BYTES = 65536;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A parsed HTTP message head: the start line and its header block. */
export interface HttpHead {
  line: string;
  /** Header fields in wire order, before Fetch's Headers canonicalization. */
  rawHeaders: readonly (readonly [string, string])[];
  headers: Headers;
}

function parse_head(text: string, strict_crlf: boolean): HttpHead {
  if (strict_crlf && /(^|[^\r])\n/.test(text)) {
    throw new Error("HTTP requires CRLF line endings");
  }
  const lines = strict_crlf ? text.split("\r\n") : text.split(/\r?\n/);
  const headers = new Headers();
  const rawHeaders: [string, string][] = [];
  for (const header of lines.slice(1)) {
    if (header === "") continue;
    const colon = header.indexOf(":");
    if (colon <= 0 || /\s/.test(header.slice(0, colon))) {
      throw new Error(`malformed HTTP header: ${header}`);
    }
    const name = header.slice(0, colon);
    // RFC 9112 forbids CR inside field values, and control characters other
    // than HTAB and SP have no place in them at all.
    const raw_value = header.slice(colon + 1);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r]/.test(raw_value)) {
      throw new Error(`malformed HTTP header: ${header}`);
    }
    const value = raw_value.trim();
    rawHeaders.push([name, value]);
    headers.append(name, value);
  }
  return { line: lines[0]!, rawHeaders, headers };
}

/**
 * A buffered reader over a byte stream: splits HTTP message heads from the
 * body bytes that follow them.
 */
export class ByteReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array = new Uint8Array(0);
  #ended = false;
  #strict_crlf: boolean;

  constructor(stream: ReadableStream<Uint8Array>, options: { strictCrlf?: boolean } = {}) {
    this.#reader = stream.getReader();
    this.#strict_crlf = options.strictCrlf ?? false;
  }

  async #fill() {
    while (!this.#ended) {
      const { value, done } = await this.#reader.read();
      if (done) {
        this.#ended = true;
        return false;
      }
      if (value.byteLength === 0) continue;
      if (this.#buffer.byteLength === 0) {
        this.#buffer = value;
      } else {
        const merged = new Uint8Array(this.#buffer.byteLength + value.byteLength);
        merged.set(this.#buffer);
        merged.set(value, this.#buffer.byteLength);
        this.#buffer = merged;
      }
      return true;
    }
    return false;
  }

  #consume(length: number) {
    const bytes = this.#buffer.subarray(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return bytes;
  }

  /**
   * Reads a message head, ending at the first blank line. Resolves undefined
   * on a clean end of stream before any byte.
   */
  async head(): Promise<HttpHead | undefined> {
    let searched = 0;
    for (;;) {
      const bytes = this.#buffer;
      for (let index = searched; index < bytes.byteLength - 1; index++) {
        let end: number;
        if (this.#strict_crlf) {
          if (
            bytes[index] !== 0x0d ||
            bytes[index + 1] !== 0x0a ||
            bytes[index + 2] !== 0x0d ||
            bytes[index + 3] !== 0x0a
          )
            continue;
          end = index + 4;
        } else {
          if (bytes[index] !== 0x0a) continue;
          let next = index + 1;
          if (bytes[next] === 0x0d) next++;
          if (bytes[next] !== 0x0a) continue;
          end = next + 1;
        }
        if (end > MAX_HEAD_BYTES) throw new Error("HTTP head too large");
        const text = decoder.decode(this.#consume(end));
        return parse_head(text, this.#strict_crlf);
      }
      searched = Math.max(0, bytes.byteLength - 3);
      if (bytes.byteLength > MAX_HEAD_BYTES) throw new Error("HTTP head too large");
      if (await this.#fill()) continue;
      if (bytes.byteLength === 0) return undefined;
      throw new Error("unexpected end of HTTP head");
    }
  }

  /** Reads through the next LF, returning the line without its CR LF. */
  async line(): Promise<string> {
    for (;;) {
      const index = this.#buffer.indexOf(0x0a);
      if (index !== -1) {
        if (index + 1 > MAX_LINE_BYTES) throw new Error("HTTP line too long");
        const bytes = this.#consume(index + 1);
        const end = index > 0 && bytes[index - 1] === 0x0d ? index - 1 : index;
        if (this.#strict_crlf) {
          if (index === 0 || bytes[index - 1] !== 0x0d) {
            throw new Error("HTTP requires CRLF line endings");
          }
          // A CR may only be the line terminator, never inside the line.
          for (let at = 0; at < end; at++) {
            if (bytes[at] === 0x0d) throw new Error("HTTP requires CRLF line endings");
          }
        }
        return decoder.decode(bytes.subarray(0, end));
      }
      if (this.#buffer.byteLength > MAX_LINE_BYTES) throw new Error("HTTP line too long");
      if (!(await this.#fill())) throw new Error("unexpected end of HTTP line");
    }
  }

  /** Reads up to `limit` bytes, resolving undefined at the end of stream. */
  async take(limit: number): Promise<Uint8Array | undefined> {
    if (this.#buffer.byteLength === 0 && !(await this.#fill())) return undefined;
    return this.#consume(Math.min(limit, this.#buffer.byteLength));
  }

  /** Cancels the underlying stream. */
  cancel(reason?: unknown) {
    return this.#reader.cancel(reason);
  }

  /** Releases transport ownership and returns bytes already read past the message. */
  detach(): Uint8Array {
    const unread = this.#buffer.slice();
    this.#buffer = new Uint8Array(0);
    this.#reader.releaseLock();
    return unread;
  }
}

/** Parses an origin-form HTTP/1.x request line, e.g. `GET /path HTTP/1.1`. */
export function parse_request_line(line: string): { method: string; target: string } {
  const match = /^([A-Z]+) (\/[^ ]*) HTTP\/1\.[01]$/.exec(line);
  if (!match) throw new Error(`unsupported HTTP request line: ${line}`);
  // Request targets are ASCII URIs; anything else (control characters,
  // non-ASCII bytes, fragments) must be percent-encoded.
  if (/[#\\\u0000-\u001f\u007f-\uffff]/.test(match[2]!)) {
    throw new Error(`unsupported HTTP request target: ${match[2]}`);
  }
  return { method: match[1]!, target: match[2]! };
}

/** Parses an HTTP/1.x status line, e.g. `HTTP/1.1 200 OK`. */
export function parse_status_line(line: string): { status: number; text: string } {
  const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(line);
  if (!match) throw new Error(`malformed HTTP status line: ${line}`);
  return { status: Number(match[1]), text: match[2] ?? "" };
}

/**
 * The body framing a message head declares: a byte count, chunked transfer
 * encoding, or nothing.
 */
export function declared_body(headers: Headers): number | "chunked" | undefined {
  const encoding = headers.get("transfer-encoding");
  const declared = headers.get("content-length");
  if (encoding !== null) {
    if (declared !== null)
      throw new Error("HTTP message has both transfer-encoding and content-length");
    if (encoding.toLowerCase() !== "chunked") {
      throw new Error(`unsupported transfer encoding: ${encoding}`);
    }
    return "chunked";
  }
  if (declared === null) return undefined;
  if (!/^[0-9]+$/.test(declared)) throw new Error(`invalid content length: ${declared}`);
  const length = Number(declared);
  if (!Number.isSafeInteger(length)) {
    throw new Error(`invalid content length: ${declared}`);
  }
  return length;
}

/** Validates framing from ordered wire fields before Headers combines them. */
export function declared_raw_body(head: HttpHead): number | "chunked" | undefined {
  const lengths = head.rawHeaders.filter(([name]) => name.toLowerCase() === "content-length");
  const encodings = head.rawHeaders.filter(([name]) => name.toLowerCase() === "transfer-encoding");
  if (lengths.length > 1) throw new Error("HTTP message has duplicate content-length");
  if (encodings.length > 1) throw new Error("HTTP message has duplicate transfer-encoding");
  return declared_body(head.headers);
}

/** Streams exactly `length` body bytes, then ends. */
export function fixed_body(reader: ByteReader, length: number): ReadableStream<Uint8Array> {
  let remaining = length;
  return new ReadableStream({
    async pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const chunk = await reader.take(remaining);
      if (!chunk) throw new Error("HTTP body ended early");
      remaining -= chunk.byteLength;
      controller.enqueue(chunk);
      if (remaining === 0) controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** RFC 9112 chunk-size syntax: hex digits plus optional chunk extensions. */
const CHUNK_SIZE_RE =
  /^[0-9a-fA-F]+(?:;[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:=(?:"[^"]*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+))?)*$/;

/** Decodes a chunked transfer coding, discarding any trailer fields. */
export function chunked_body(reader: ByteReader): ReadableStream<Uint8Array> {
  let remaining = 0;
  let between_chunks = false;
  return new ReadableStream({
    async pull(controller) {
      if (remaining === 0) {
        if (between_chunks) {
          if ((await reader.line()) !== "") throw new Error("malformed chunk boundary");
          between_chunks = false;
        }
        const size_line = await reader.line();
        if (!CHUNK_SIZE_RE.test(size_line)) {
          throw new Error(`malformed chunk size: ${size_line}`);
        }
        remaining = Number.parseInt(size_line, 16);
        if (!Number.isSafeInteger(remaining))
          throw new Error(`chunk size is too large: ${size_line}`);
        if (remaining === 0) {
          let trailer_bytes = 0;
          for (;;) {
            const trailer = await reader.line();
            trailer_bytes += trailer.length + 2;
            if (trailer_bytes > MAX_TRAILER_BYTES) throw new Error("HTTP trailers too large");
            if (trailer === "") break;
          }
          controller.close();
          return;
        }
      }
      const chunk = await reader.take(remaining);
      if (!chunk) throw new Error("HTTP body ended early");
      remaining -= chunk.byteLength;
      if (remaining === 0) between_chunks = true;
      controller.enqueue(chunk);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Streams the remaining bytes until the connection ends. */
export function eof_body(reader: ByteReader): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const chunk = await reader.take(Infinity);
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Applies the chunked transfer coding to a byte stream. */
export function chunked_encoder(): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.byteLength === 0) return;
      controller.enqueue(encoder.encode(`${chunk.byteLength.toString(16)}\r\n`));
      controller.enqueue(chunk);
      controller.enqueue(encoder.encode("\r\n"));
    },
    flush(controller) {
      controller.enqueue(encoder.encode("0\r\n\r\n"));
    },
  });
}

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

/** Removes connection-scoped headers, including fields named by Connection. */
export function strip_hop_by_hop(headers: Headers, additional: readonly string[] = []) {
  const connection = headers.get("connection");
  if (connection !== null) {
    for (const name of connection.split(",")) {
      const token = name.trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(token)) {
        throw new Error(`invalid Connection header: ${connection}`);
      }
      headers.delete(token);
    }
  }
  for (const name of HOP_BY_HOP) headers.delete(name);
  for (const name of additional) headers.delete(name);
}

/** Serializes a start line and headers into the bytes of a message head. */
export function serialize_head(line: string, headers: Headers): Uint8Array {
  let text = `${line}\r\n`;
  for (const [name, value] of headers) text += `${name}: ${value}\r\n`;
  return encoder.encode(`${text}\r\n`);
}
