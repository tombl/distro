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

/** Metadata about a file, as returned by `guest.fs.stat` and friends. */
export interface FileInfo {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
  /** Size in bytes. */
  readonly size: number;
  readonly mtime: Date | null;
  readonly atime: Date | null;
  /** Always `null`; the guest does not track creation time. */
  readonly birthtime: Date | null;
  readonly dev: number;
  readonly ino: number;
  /** The full mode, including the file type bits. */
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly gid: number;
  /** Size in 512-byte blocks. */
  readonly blocks: number;
}

/** One entry yielded by `guest.fs.readDir`. */
export interface DirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
}

/**
 * Options for `guest.fs.open`. Without `write` or `append` the file opens
 * read-only.
 */
export interface OpenOptions {
  read?: boolean;
  write?: boolean;
  /** Open for appending: every write goes to the end of the file. */
  append?: boolean;
  /** Truncate the file to zero length on open. */
  truncate?: boolean;
  /** Create the file if it does not exist. */
  create?: boolean;
  /** Create the file, failing with `"EEXIST"` if it already exists. */
  createNew?: boolean;
  /** Permission bits for a created file. */
  mode?: number;
}

/** Options for `guest.fs.writeFile` and `guest.fs.writeTextFile`. */
export interface WriteFileOptions {
  /** Append to the file instead of truncating it. */
  append?: boolean;
  /** Create the file if it does not exist. Defaults to `true`. */
  create?: boolean;
  /** Create the file, failing with `"EEXIST"` if it already exists. */
  createNew?: boolean;
  /** Permission bits for a created file. */
  mode?: number;
  signal?: AbortSignal;
}

/** Options for `guest.fs.mkdir`. */
export interface MkdirOptions {
  /** Create missing parents, and do not fail if the directory exists. */
  recursive?: boolean;
  /** Permission bits for the created directory. */
  mode?: number;
}

/** The starting point for `FsFile.seek`, matching `lseek`'s `whence`. */
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

/**
 * An open guest file, returned by `guest.fs.open`.
 *
 * Reads and writes share the guest file offset, so operations on an `FsFile`
 * are serialized. The file is an async disposable: `await using` closes it
 * when the block ends.
 */
export class FsFile implements AsyncDisposable {
  #tail = Promise.resolve<void>(undefined);
  #closed = false;
  #close?: Promise<void>;
  readonly #fd: GuestFd;

  /** The file as a byte stream, read from the current offset to the end. */
  readonly readable: ReadableStream<Uint8Array>;
  /** The file as a byte sink; each write goes to the current offset. */
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

  /**
   * Reads up to `buffer.byteLength` bytes at the current offset into
   * `buffer`. Resolves to the number of bytes read, or `null` at end of
   * file.
   */
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

  /** Metadata for the open file. */
  stat(): Promise<FileInfo> {
    return this.#run(async () => {
      // fstatat64 needs a path; stat the fd through /proc/self/fd/N (the
      // agent mounts /proc at startup for exactly this and realPath).
      return statToInfo(await fstatat64(this.#fd.session, `/proc/self/fd/${this.#fd.fd}`, 0));
    });
  }

  /** Truncates the file to `length` bytes, defaulting to empty. */
  truncate(length = 0): Promise<void> {
    return this.#run(() => ftruncate64(this.#fd, BigInt(length)));
  }

  /** Flushes the file's data to the underlying storage. */
  sync(): Promise<void> {
    return this.#run(() => fsync(this.#fd));
  }

  /** Closes the file. Also called when an `await using` scope ends. */
  close(): Promise<void> {
    this.#closed = true;
    return (this.#close ??= this.#tail.then(() => this.#fd.close()));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
