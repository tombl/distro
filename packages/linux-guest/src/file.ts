import { AT, NR, O, S_IF, Stat, statSize } from "./abi.ts";
import type { GuestConn, SyscallArg, SyscallResult } from "./conn.ts";
import { SystemError } from "./errors.ts";

// Host convention for bulk I/O: 32 KiB chunks (protocol.md, "Concurrency").
export const CHUNK = 32 * 1024;

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

// --- low-level syscall helpers (shared by the veneer) ----------------------

/** A path argument as a C string: UTF-8 bytes plus a trailing NUL, passed to
 *  the guest as an in-blob. Rejects embedded NUL like the v1 protocol did. */
export function cString(value: string): { in: Uint8Array } {
  const utf8 = new TextEncoder().encode(value);
  if (utf8.includes(0)) {
    throw new TypeError("guest strings cannot contain NUL");
  }
  const bytes = new Uint8Array(utf8.byteLength + 1);
  bytes.set(utf8);
  return { in: bytes };
}

/** Split a 64-bit value into [low, high] 32-bit words for the ILP32 ABI. */
export function loHi(value: bigint): [number, number] {
  const u = BigInt.asUintN(64, value);
  return [Number(u & 0xffffffffn), Number(u >> 32n)];
}

/** Run an injected syscall and convert a -1 return into a {@link SystemError}
 *  with the given name/paths, exactly as the v1 protocol surfaced errors. */
export async function sys(
  conn: GuestConn,
  nr: number,
  name: string,
  args: SyscallArg[],
  path?: string,
  dest?: string,
): Promise<SyscallResult> {
  const result = await conn.syscall(nr, ...args);
  if (result.ret === -1n) {
    throw new SystemError(result.errno, name, path, dest);
  }
  return result;
}

/** openat(AT_FDCWD, path, flags, mode), returning the fd. */
export async function openFd(
  conn: GuestConn,
  path: string,
  flags: number,
  mode: number,
  dest?: string,
): Promise<number> {
  const result = await sys(
    conn,
    NR.openat,
    "open",
    [AT.FDCWD, cString(path), flags, mode],
    path,
    dest,
  );
  return Number(result.ret);
}

/** Best-effort close; tolerates a dead connection or already-closed fd. */
export async function closeFd(conn: GuestConn, fd: number): Promise<void> {
  await conn.syscall(NR.close, fd).catch(() => {});
}

export function decodeStat(bytes: Uint8Array): FileInfo {
  const st = new Stat(bytes);
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
  const write = options.write ?? options.append ?? false;
  const read = options.read ?? !write;
  let flags = read && write ? O.RDWR : write ? O.WRONLY : O.RDONLY;
  if (options.create) flags |= O.CREAT;
  if (options.createNew) flags |= O.CREAT | O.EXCL;
  if (options.truncate) flags |= O.TRUNC;
  if (options.append) flags |= O.APPEND;
  return flags;
}

export class FsFile implements AsyncDisposable {
  #tail = Promise.resolve<unknown>(undefined);
  #closed = false;

  readonly #conn: GuestConn;
  readonly #fd: number;
  readonly #path: string;

  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(conn: GuestConn, fd: number, path: string) {
    this.#conn = conn;
    this.#fd = fd;
    this.#path = path;

    this.readable = new ReadableStream({
      type: "bytes",
      pull: async (controller) => {
        const buffer = new Uint8Array(CHUNK);
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
            throw new SystemError(5, "write", this.#path); // EIO
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
      const capacity = Math.min(buffer.byteLength, CHUNK);
      const result = await sys(
        this.#conn,
        NR.read,
        "read",
        [this.#fd, { out: capacity, retSized: true }, capacity],
        this.#path,
      );
      if (result.ret === 0n) return null;
      const data = result.out[0]!;
      buffer.set(data);
      return data.byteLength;
    });
  }

  write(buffer: Uint8Array): Promise<number> {
    return this.#run(async () => {
      const chunk = buffer.subarray(0, CHUNK);
      const result = await sys(
        this.#conn,
        NR.write,
        "write",
        [this.#fd, { in: chunk }, chunk.byteLength],
        this.#path,
      );
      return Number(result.ret);
    });
  }

  seek(offset: number | bigint, whence: SeekMode): Promise<number> {
    return this.#run(async () => {
      const [lo, hi] = loHi(BigInt(offset));
      const result = await sys(
        this.#conn,
        NR.llseek,
        "_llseek",
        [this.#fd, hi, lo, { out: 8 }, whence],
        this.#path,
      );
      const out = result.out[0]!;
      const position = new DataView(out.buffer, out.byteOffset, out.byteLength).getBigInt64(
        0,
        true,
      );
      return Number(position);
    });
  }

  stat(): Promise<FileInfo> {
    return this.#run(async () => {
      // fstatat64 needs a path; the empty-path / AT_EMPTY_PATH trick is not in
      // abi.ts, so stat the fd through /proc/self/fd/N, which the agent mounts.
      const result = await sys(
        this.#conn,
        NR.fstatat64,
        "fstat",
        [AT.FDCWD, cString(`/proc/self/fd/${this.#fd}`), { out: statSize }, 0],
        this.#path,
      );
      return decodeStat(result.out[0]!);
    });
  }

  truncate(length = 0): Promise<void> {
    return this.#run(async () => {
      const [lo, hi] = loHi(BigInt(length));
      await sys(this.#conn, NR.ftruncate64, "ftruncate", [this.#fd, lo, hi], this.#path);
    });
  }

  sync(): Promise<void> {
    return this.#run(async () => {
      await sys(this.#conn, NR.fsync, "fsync", [this.#fd], this.#path);
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    void this.#conn.syscall(NR.close, this.#fd).catch(() => {});
  }

  async [Symbol.asyncDispose]() {
    this.close();
  }
}
