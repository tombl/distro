import { Struct, U16LE, U32LE, U64LE } from "@tombl/linux/bytes";
import type { VsockConnection, VsockDevice } from "@tombl/linux";

const AGENT_PORT = 1024;
const AGENT_MAGIC = 0x31414754;
const AGENT_VERSION = 1;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;

const AgentOp = {
  PING: 1,
  READ_FILE: 2,
  WRITE_FILE: 3,
  STAT: 4,
  LIST_DIR: 5,
  EXEC: 6,
} as const;

const WriteFlags = {
  CREATE: 1 << 0,
  TRUNCATE: 1 << 1,
  APPEND: 1 << 2,
} as const;

const AgentHeader = Struct({
  magic: U32LE,
  version: U16LE,
  op: U16LE,
  id: U32LE,
  status: U32LE,
  payload_len: U32LE,
  reserved: U32LE,
});

const StatPayload = Struct({
  size: U64LE,
  mode: U32LE,
  uid: U32LE,
  gid: U32LE,
  kind: U32LE,
  mtime_sec: U64LE,
  ino: U64LE,
});

export type GuestFileKind = "unknown" | "file" | "directory" | "symlink";

export interface GuestFileInfo {
  size: bigint;
  mode: number;
  uid: number;
  gid: number;
  kind: GuestFileKind;
  mtime: Date;
  ino: bigint;
}

export interface GuestDirEntry {
  name: string;
  kind: GuestFileKind;
}

export interface GuestExecOutput {
  status: number;
  code: number | null;
  signal: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface GuestWriteOptions {
  create?: boolean;
  truncate?: boolean;
  append?: boolean;
  mode?: number;
  offset?: bigint;
}

function assert(cond: unknown, message = "Assertion failed"): asserts cond {
  if (!cond) throw new Error(message);
}

function errno_name(errno: number) {
  return `E${errno}`;
}

function signed_u32(value: number) {
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function concat_bytes(chunks: Uint8Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function u32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u64(value: bigint) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function read_u32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function read_u64(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

function encode_path(path: string) {
  const bytes = new TextEncoder().encode(path);
  return concat_bytes([u32(bytes.byteLength), bytes]);
}

function decode_kind(kind: number): GuestFileKind {
  switch (kind) {
    case 1:
      return "file";
    case 2:
      return "directory";
    case 3:
      return "symlink";
    default:
      return "unknown";
  }
}

export class GuestAgentError extends Error {
  errno: number;

  constructor(op: number, status: number) {
    const errno = -status;
    super(`guest agent op ${op} failed with ${errno_name(errno)}`);
    this.errno = errno;
  }
}

export class GuestAgentClient {
  #vsock: VsockDevice;
  #connection?: VsockConnection;
  #next_id = 1;

  constructor(vsock: VsockDevice) {
    this.#vsock = vsock;
  }

  async connect({ timeoutMs = 5000 } = {}) {
    this.#connection ??= await this.#vsock.connect(AGENT_PORT, { timeoutMs });
  }

  async close() {
    this.#connection?.close();
    this.#connection = undefined;
  }

  async ping() {
    const response = await this.#request(AgentOp.PING, new Uint8Array());
    return new TextDecoder().decode(response);
  }

  async readFile(path: string, { offset = 0n, length = DEFAULT_CHUNK_SIZE } = {}) {
    return await this.#request(
      AgentOp.READ_FILE,
      concat_bytes([encode_path(path), u64(offset), u32(length)]),
    );
  }

  readable(path: string, { chunkSize = 64 * 1024 } = {}) {
    let offset = 0n;
    const agent = this;

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await agent.readFile(path, { offset, length: chunkSize });
        if (chunk.byteLength === 0) {
          controller.close();
          return;
        }
        offset += BigInt(chunk.byteLength);
        controller.enqueue(chunk);
      },
    });
  }

  async writeFile(path: string, data: Uint8Array, options: GuestWriteOptions = {}) {
    const flags =
      ((options.create ?? true) ? WriteFlags.CREATE : 0) |
      ((options.truncate ?? true) ? WriteFlags.TRUNCATE : 0) |
      (options.append ? WriteFlags.APPEND : 0);
    const response = await this.#request(
      AgentOp.WRITE_FILE,
      concat_bytes([
        encode_path(path),
        u32(options.mode ?? 0o644),
        u64(options.offset ?? 0n),
        u32(data.byteLength),
        u32(flags),
        data,
      ]),
    );
    assert(response.byteLength === 8, "short write response");
    return read_u64(response, 0);
  }

  writable(path: string, options: GuestWriteOptions = {}) {
    let offset = options.offset ?? 0n;
    let first = true;
    const agent = this;

    return new WritableStream<Uint8Array>({
      async write(chunk) {
        const written = await agent.writeFile(path, chunk, {
          ...options,
          offset,
          truncate: first ? options.truncate : false,
        });
        first = false;
        offset += written;
      },
    });
  }

  async stat(path: string): Promise<GuestFileInfo> {
    const response = await this.#request(AgentOp.STAT, encode_path(path));
    assert(response.byteLength === StatPayload.size, "short stat response");
    const stat = new StatPayload(response);
    return {
      size: stat.size,
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
      kind: decode_kind(stat.kind),
      mtime: new Date(Number(stat.mtime_sec) * 1000),
      ino: stat.ino,
    };
  }

  async readDir(path: string): Promise<GuestDirEntry[]> {
    const response = await this.#request(AgentOp.LIST_DIR, encode_path(path));
    const entries: GuestDirEntry[] = [];
    let offset = 0;
    while (offset < response.byteLength) {
      const kind = response[offset++];
      assert(kind !== undefined && response.byteLength - offset >= 4, "short dir entry");
      const name_len = read_u32(response, offset);
      offset += 4;
      assert(response.byteLength - offset >= name_len, "short dir entry name");
      const name = new TextDecoder().decode(response.subarray(offset, offset + name_len));
      offset += name_len;
      entries.push({ name, kind: decode_kind(kind) });
    }
    return entries;
  }

  async exec(argv: string[], { captureLimit = 1024 * 1024 } = {}): Promise<GuestExecOutput> {
    assert(argv.length > 0, "exec argv must not be empty");
    const encoded = argv.map((arg) => new TextEncoder().encode(arg));
    const payload = concat_bytes([
      u32(encoded.length),
      u32(captureLimit),
      ...encoded.flatMap((arg) => [u32(arg.byteLength), arg]),
    ]);
    const response = await this.#request(AgentOp.EXEC, payload);
    assert(response.byteLength >= 20, "short exec response");

    const status = read_u32(response, 0);
    const code = read_u32(response, 4);
    const signal = read_u32(response, 8);
    const stdout_len = read_u32(response, 12);
    const stderr_len = read_u32(response, 16);
    assert(response.byteLength === 20 + stdout_len + stderr_len, "bad exec response length");

    return {
      status,
      code: signal === 0 ? code : null,
      signal: signal === 0 ? null : signal,
      stdout: response.subarray(20, 20 + stdout_len),
      stderr: response.subarray(20 + stdout_len),
    };
  }

  async #request(op: number, payload: Uint8Array) {
    await this.connect();
    const connection = this.#connection!;
    const id = this.#next_id++;
    const request = new Uint8Array(AgentHeader.size + payload.byteLength);
    const header = new AgentHeader(request);
    header.magic = AGENT_MAGIC;
    header.version = AGENT_VERSION;
    header.op = op;
    header.id = id;
    header.status = 0;
    header.payload_len = payload.byteLength;
    header.reserved = 0;
    request.set(payload, AgentHeader.size);
    connection.write(request);

    const response_header_bytes = await connection.readExactly(AgentHeader.size);
    assert(response_header_bytes.byteLength === AgentHeader.size, "guest agent closed connection");
    const response_header = new AgentHeader(response_header_bytes);
    assert(response_header.magic === AGENT_MAGIC, "bad guest agent magic");
    assert(response_header.version === AGENT_VERSION, "bad guest agent version");
    assert(
      response_header.op === op,
      `bad guest agent op: expected ${op}, got ${response_header.op}`,
    );
    assert(
      response_header.id === id,
      `bad guest agent id: expected ${id}, got ${response_header.id}`,
    );

    const response = await connection.readExactly(response_header.payload_len);
    assert(response.byteLength === response_header.payload_len, "short guest agent response");
    const status = signed_u32(response_header.status);
    if (status < 0) throw new GuestAgentError(op, status);
    return response;
  }
}
