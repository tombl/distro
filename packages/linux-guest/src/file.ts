// FsFile: an open guest file as a JS object, plus the public option/info
// types and the Stat -> FileInfo presentation shared with client.ts.

import { E, O, S_IF, Stat, SystemError } from "./abi.ts";
import {
  CHUNK,
  fstatat64,
  fsync,
  ftruncate64,
  type GuestFd,
  llseek,
  read,
  write,
} from "./syscalls.ts";

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

export function statToInfo(st: InstanceType<typeof Stat>): FileInfo {
  const type = st.st_mode & S_IF.MT;
  return {
    isFile: type === S_IF.REG,
    isDirectory: type === S_IF.DIR,
    isSymlink: type === S_IF.LNK,
    size: Number(st.st_size),
    mtime: new Date(st.st_mtime * 1000 + st.st_mtime_nsec / 1_000_000),
    atime: new Date(st.st_atime * 1000 + st.st_atime_nsec / 1_000_000),
    birthtime: null,
    dev: Number(st.st_dev),
    ino: Number(st.st_ino),
    mode: st.st_mode,
    nlink: st.st_nlink,
    uid: st.st_uid,
    gid: st.st_gid,
    blocks: Number(st.st_blocks),
  };
}

export function openFlags(options: OpenOptions = {}): number {
  const wants_write = options.write ?? options.append ?? false;
  const wants_read = options.read ?? !wants_write;
  let flags = wants_read && wants_write ? O.RDWR : wants_write ? O.WRONLY : O.RDONLY;
  if (options.create) flags |= O.CREAT;
  if (options.createNew) flags |= O.CREAT | O.EXCL;
  if (options.truncate) flags |= O.TRUNC;
  if (options.append) flags |= O.APPEND;
  return flags;
}

export class FsFile implements AsyncDisposable {
  #tail = Promise.resolve<void>(undefined);
  #closed = false;
  readonly #fd: GuestFd;

  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(fd: GuestFd) {
    this.#fd = fd;

    this.readable = new ReadableStream({
      type: "bytes",
      pull: async (controller) => {
        const buffer = new Uint8Array(CHUNK);
        const length = await this.read(buffer);
        if (length === null) {
          await this.close();
          controller.close();
        } else {
          controller.enqueue(buffer.subarray(0, length));
        }
      },
      cancel: () => this.close(),
    });
    this.writable = new WritableStream({
      write: async (chunk) => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = await this.write(chunk.subarray(offset));
          if (written === 0) {
            throw new SystemError(E.IO);
          }
          offset += written;
        }
      },
      close: () => this.close(),
      abort: () => this.close(),
    });
  }

  // Reads and writes share a file offset in the guest, so operations on an
  // FsFile are serialized.
  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new TypeError("file is closed"));
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  read(buffer: Uint8Array): Promise<number | null> {
    if (buffer.byteLength === 0) return Promise.resolve(0);
    return this.#run(async () => {
      const data = await read(this.#fd, Math.min(buffer.byteLength, CHUNK));
      if (data.byteLength === 0) return null;
      buffer.set(data);
      return data.byteLength;
    });
  }

  write(buffer: Uint8Array): Promise<number> {
    return this.#run(() => write(this.#fd, buffer.subarray(0, CHUNK)));
  }

  seek(offset: number | bigint, whence: SeekMode): Promise<number> {
    return this.#run(async () => Number(await llseek(this.#fd, BigInt(offset), whence)));
  }

  stat(): Promise<FileInfo> {
    return this.#run(async () => {
      // fstatat64 needs a path; stat the fd through /proc/self/fd/N (the
      // agent mounts /proc at startup for exactly this and realPath).
      return statToInfo(await fstatat64(this.#fd.session, `/proc/self/fd/${this.#fd.fd}`, 0));
    });
  }

  truncate(length = 0): Promise<void> {
    return this.#run(() => ftruncate64(this.#fd, BigInt(length)));
  }

  sync(): Promise<void> {
    return this.#run(() => fsync(this.#fd));
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.#fd.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
