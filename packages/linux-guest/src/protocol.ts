import type { VsockConnection, VsockDevice } from "@tombl/linux";
import {
  Bytes,
  I64LE,
  Struct,
  type Type,
  U16LE,
  U32LE,
  U64LE,
} from "@tombl/linux/bytes";
import { ProtocolError, SystemError } from "./errors.ts";

export const agentPort = 1024;
export const maxMetadata = 64 * 1024;
export const maxFramePayload = 64 * 1024 - 8;

export const ConnectionKind = {
  Ping: 1,
  ReadFile: 2,
  WriteFile: 3,
  ReadDir: 4,
  Stat: 5,
  Lstat: 6,
  Mkdir: 7,
  Remove: 8,
  Rename: 9,
  CopyFile: 10,
  RealPath: 11,
  ReadLink: 12,
  Symlink: 13,
  Chmod: 14,
  Chown: 15,
  Truncate: 16,
  OpenFile: 17,
  ExecControl: 32,
  ExecStdin: 33,
  ExecStdout: 34,
  ExecStderr: 35,
} as const;

export const MessageType = {
  Data: 1,
  End: 2,
  Error: 3,
  Entry: 4,
  FileRead: 16,
  FileWrite: 17,
  FileSeek: 18,
  FileStat: 19,
  FileTruncate: 20,
  FileSync: 21,
  FileClose: 22,
  Start: 32,
  Signal: 33,
  Status: 34,
} as const;

export interface Frame {
  type: number;
  payload: Uint8Array;
}

class Prelude extends Struct({
  magic: U32LE,
  version: U16LE,
  kind: U16LE,
  metadataLength: U32LE,
}) {}

class FrameHeader extends Struct({
  length: U32LE,
  type: U16LE,
  flags: U16LE,
}) {}

function encode<T>(type: Type<T>, value: T) {
  const bytes = new Uint8Array(type.size);
  type.set(new DataView(bytes.buffer), 0, value);
  return bytes;
}

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function concat(chunks: readonly Uint8Array[]) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Bytes(length || 1);
  for (const chunk of chunks) output.append(chunk);
  return output.array;
}

export function u32(value: number) {
  return encode(U32LE, value);
}

export function u64(value: number | bigint) {
  return encode(U64LE, BigInt(value));
}

export function i64(value: number | bigint) {
  return encode(I64LE, BigInt(value));
}

export function readU32(bytes: Uint8Array, offset = 0) {
  return U32LE.get(view(bytes), offset);
}

export function readU64(bytes: Uint8Array, offset = 0) {
  return U64LE.get(view(bytes), offset);
}

export function string(value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.includes(0)) {
    throw new TypeError("guest strings cannot contain NUL");
  }
  return concat([u32(bytes.byteLength), bytes]);
}

export function strings(values: readonly string[]) {
  return concat([u32(values.length), ...values.map(string)]);
}

export async function connect(
  device: VsockDevice,
  kind: number,
  metadata: Uint8Array = new Uint8Array(),
  timeoutMs = 5000,
) {
  if (metadata.byteLength > maxMetadata) {
    throw new RangeError("guest protocol metadata is too large");
  }
  const connection = await device.connect(agentPort, { timeoutMs });
  const preludeBytes = new Uint8Array(Prelude.size);
  const prelude = new Prelude(preludeBytes);
  prelude.magic = 0x584e4c54;
  prelude.version = 1;
  prelude.kind = kind;
  prelude.metadataLength = metadata.byteLength;
  try {
    await connection.write(concat([preludeBytes, metadata]));
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

export async function writeFrame(
  connection: VsockConnection,
  type: number,
  payload: Uint8Array = new Uint8Array(),
) {
  if (payload.byteLength > maxFramePayload) {
    throw new RangeError("guest protocol frame is too large");
  }
  const headerBytes = new Uint8Array(FrameHeader.size);
  const header = new FrameHeader(headerBytes);
  header.length = payload.byteLength;
  header.type = type;
  header.flags = 0;
  await connection.write(concat([headerBytes, payload]));
}

export async function readFrame(connection: VsockConnection): Promise<Frame> {
  const bytes = await connection.readExactly(FrameHeader.size);
  if (bytes.byteLength !== FrameHeader.size) {
    throw new ProtocolError("guest connection closed mid-frame");
  }
  const header = new FrameHeader(bytes);
  if (header.length > maxFramePayload) {
    throw new ProtocolError("oversized guest frame");
  }
  if (header.flags !== 0) {
    throw new ProtocolError("unsupported guest frame flags");
  }
  const payload = await connection.readExactly(header.length);
  if (payload.byteLength !== header.length) {
    throw new ProtocolError("guest connection closed mid-frame");
  }
  return { type: header.type, payload };
}

export function throwIfError(
  frame: Frame,
  syscall: string,
  path?: string,
  destination?: string,
) {
  if (frame.type !== MessageType.Error) return;
  if (frame.payload.byteLength !== 4) {
    throw new ProtocolError("invalid error frame");
  }
  throw new SystemError(readU32(frame.payload), syscall, path, destination);
}

export async function expectEnd(
  connection: VsockConnection,
  syscall: string,
  path?: string,
  destination?: string,
) {
  const frame = await readFrame(connection);
  throwIfError(frame, syscall, path, destination);
  if (frame.type !== MessageType.End || frame.payload.byteLength) {
    throw new ProtocolError(`expected end frame for ${syscall}`);
  }
}

export function abortConnection(
  connection: VsockConnection,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!signal) return () => {};
  const abort = () => connection.close();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener("abort", abort);
}
