import type { VsockConnection } from "@tombl/linux";
import { Struct, U32LE, U64LE } from "@tombl/linux/bytes";
import {
  concat,
  expectEnd,
  i64,
  maxFramePayload,
  MessageType,
  readFrame,
  readU32,
  readU64,
  throwIfError,
  u32,
  u64,
  writeFrame,
} from "./protocol.ts";
import { ProtocolError } from "./errors.ts";

export interface FileInfo {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
  readonly size: number;
  readonly mtime: Date | null;
  readonly atime: Date | null;
  readonly birthtime: Date | null;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly gid: number;
  readonly blocks: number;
}

export interface DirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
}

export interface OpenOptions {
  read?: boolean;
  write?: boolean;
  append?: boolean;
  truncate?: boolean;
  create?: boolean;
  createNew?: boolean;
  mode?: number;
}

export interface WriteFileOptions {
  append?: boolean;
  create?: boolean;
  createNew?: boolean;
  mode?: number;
  signal?: AbortSignal;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

export const SeekMode = {
  Start: 0,
  Current: 1,
  End: 2,
} as const;

export type SeekMode = (typeof SeekMode)[keyof typeof SeekMode];

function date(seconds: bigint, nanoseconds: number) {
  return new Date(Number(seconds) * 1000 + nanoseconds / 1_000_000);
}

class StatPayload extends Struct({
  size: U64LE,
  atimeSeconds: U64LE,
  atimeNanoseconds: U32LE,
  mtimeSeconds: U64LE,
  mtimeNanoseconds: U32LE,
  ctimeSeconds: U64LE,
  ctimeNanoseconds: U32LE,
  ino: U64LE,
  dev: U64LE,
  blocks: U64LE,
  mode: U32LE,
  nlink: U32LE,
  uid: U32LE,
  gid: U32LE,
  kind: U32LE,
}) {}

export function decodeFileInfo(payload: Uint8Array): FileInfo {
  if (payload.byteLength !== StatPayload.size) {
    throw new ProtocolError("invalid stat payload");
  }
  const stat = new StatPayload(payload);
  return {
    size: Number(stat.size),
    atime: date(stat.atimeSeconds, stat.atimeNanoseconds),
    mtime: date(stat.mtimeSeconds, stat.mtimeNanoseconds),
    birthtime: null,
    ino: Number(stat.ino),
    dev: Number(stat.dev),
    blocks: Number(stat.blocks),
    mode: stat.mode,
    nlink: stat.nlink,
    uid: stat.uid,
    gid: stat.gid,
    isFile: stat.kind === 1,
    isDirectory: stat.kind === 2,
    isSymlink: stat.kind === 3,
  };
}

export function decodeDirEntry(payload: Uint8Array): DirEntry {
  if (payload.byteLength < 4) {
    throw new ProtocolError("invalid directory entry");
  }
  const kind = readU32(payload);
  return {
    name: new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(4)),
    isFile: kind === 1,
    isDirectory: kind === 2,
    isSymlink: kind === 3,
  };
}

export function openFlags(options: OpenOptions = {}) {
  const write = options.write ?? options.append ?? false;
  const read = options.read ?? !write;
  let flags = read && write ? 2 : write ? 1 : 0;
  if (options.create) flags |= 64;
  if (options.createNew) flags |= 64 | 128;
  if (options.truncate) flags |= 512;
  if (options.append) flags |= 1024;
  return flags;
}

export class FsFile implements AsyncDisposable {
  #tail = Promise.resolve<unknown>(undefined);
  #closed = false;

  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(
    private readonly connection: VsockConnection,
    private readonly path: string,
  ) {
    this.readable = new ReadableStream({
      type: "bytes",
      pull: async (controller) => {
        const buffer = new Uint8Array(maxFramePayload);
        const length = await this.read(buffer);
        if (length === null) {
          controller.close();
          this.close();
        } else {
          controller.enqueue(buffer.subarray(0, length));
        }
      },
      cancel: () => {
        this.close();
      },
    });
    this.writable = new WritableStream({
      write: async (chunk) => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = await this.write(chunk.subarray(offset));
          if (written === 0) {
            throw new ProtocolError("guest file write made no progress");
          }
          offset += written;
        }
      },
      close: () => {
        this.close();
      },
      abort: () => {
        this.close();
      },
    });
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new TypeError("file is closed"));
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  read(buffer: Uint8Array): Promise<number | null> {
    if (buffer.byteLength === 0) return Promise.resolve(0);
    return this.#run(async () => {
      await writeFrame(
        this.connection,
        MessageType.FileRead,
        u32(Math.min(buffer.byteLength, maxFramePayload)),
      );
      const frame = await readFrame(this.connection);
      throwIfError(frame, "read", this.path);
      if (frame.type === MessageType.End) return null;
      if (
        frame.type !== MessageType.Data ||
        frame.payload.byteLength > buffer.byteLength
      ) {
        throw new ProtocolError("invalid file read response");
      }
      buffer.set(frame.payload);
      return frame.payload.byteLength;
    });
  }

  write(buffer: Uint8Array): Promise<number> {
    return this.#run(async () => {
      await writeFrame(
        this.connection,
        MessageType.FileWrite,
        buffer.subarray(0, maxFramePayload),
      );
      const frame = await readFrame(this.connection);
      throwIfError(frame, "write", this.path);
      if (frame.type !== MessageType.Data || frame.payload.byteLength !== 4) {
        throw new ProtocolError("invalid file write response");
      }
      return readU32(frame.payload);
    });
  }

  seek(offset: number | bigint, whence: SeekMode): Promise<number> {
    return this.#run(async () => {
      const payload = concat([i64(offset), u32(whence)]);
      await writeFrame(this.connection, MessageType.FileSeek, payload);
      const frame = await readFrame(this.connection);
      throwIfError(frame, "seek", this.path);
      if (frame.type !== MessageType.Data || frame.payload.byteLength !== 8) {
        throw new ProtocolError("invalid file seek response");
      }
      return Number(readU64(frame.payload));
    });
  }

  stat(): Promise<FileInfo> {
    return this.#run(async () => {
      await writeFrame(this.connection, MessageType.FileStat);
      const frame = await readFrame(this.connection);
      throwIfError(frame, "fstat", this.path);
      if (frame.type !== MessageType.Data) {
        throw new ProtocolError("invalid file stat response");
      }
      return decodeFileInfo(frame.payload);
    });
  }

  truncate(length = 0): Promise<void> {
    return this.#run(async () => {
      await writeFrame(this.connection, MessageType.FileTruncate, u64(length));
      await expectEnd(this.connection, "ftruncate", this.path);
    });
  }

  sync(): Promise<void> {
    return this.#run(async () => {
      await writeFrame(this.connection, MessageType.FileSync);
      await expectEnd(this.connection, "fsync", this.path);
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.connection.close();
  }

  async [Symbol.asyncDispose]() {
    this.close();
  }
}
