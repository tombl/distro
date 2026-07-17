// The Deno-shaped public API, composed entirely from the syscall table.
// Every operation here reads like the C it replaces; errno-based control
// flow catches SystemError, because exceptions are the errno channel.

import type { VsockDevice } from "@tombl/linux";
import { AT, DT, E, O, parse_dirents, SystemError } from "./abi.ts";
import { GuestSession } from "./conn.ts";
import {
  CHUNK,
  fchmodat,
  fchownat,
  fstatat64,
  ftruncate64,
  getdents64,
  getpid,
  type GuestFd,
  mkdirat,
  openat,
  read,
  readlinkat,
  renameat,
  spawn,
  symlinkat,
  unlinkat,
  write,
} from "./syscalls.ts";
import {
  type DirEntry,
  type FileInfo,
  FsFile,
  type MkdirOptions,
  openFlags,
  type OpenOptions,
  statToInfo,
  type WriteFileOptions,
} from "./file.ts";
import { ChildProcess } from "./process.ts";

export type FileData = Uint8Array | Blob | ReadableStream<Uint8Array>;

export interface ExecOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface FileSystem {
  readFile(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  readTextFile(path: string, options?: { signal?: AbortSignal }): Promise<string>;
  writeFile(path: string, data: FileData, options?: WriteFileOptions): Promise<void>;
  writeTextFile(
    path: string,
    data: string | ReadableStream<string>,
    options?: WriteFileOptions,
  ): Promise<void>;
  readDir(path: string): AsyncIterable<DirEntry>;
  stat(path: string): Promise<FileInfo>;
  lstat(path: string): Promise<FileInfo>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  realPath(path: string): Promise<string>;
  readLink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  truncate(path: string, length?: number): Promise<void>;
  open(path: string, options?: OpenOptions): Promise<FsFile>;
}

export type Exec = (argv: readonly string[], options?: ExecOptions) => Promise<ChildProcess>;

export interface GuestClientCapabilities {
  ping(timeoutMs?: number): Promise<void>;
  readonly fs: FileSystem;
  readonly exec: Exec;
}

// A process may hold up to four blocked lanes (reap, stdout, stderr, one
// stdin write), so this cap keeps worst-case process traffic to half the
// 64-lane pool and everything else — notably the kill that unblocks a stuck
// pipe read — can always get a lane.
const MAX_PROCESSES = 8;

function byte_stream(data: FileData): ReadableStream<Uint8Array> {
  if (data instanceof ReadableStream) return data;
  if (data instanceof Blob) return data.stream();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

async function write_all(fd: GuestFd, data: Uint8Array, signal?: AbortSignal) {
  let offset = 0;
  while (offset < data.byteLength) {
    signal?.throwIfAborted();
    const written = await write(fd, data.subarray(offset, offset + CHUNK));
    if (written === 0) throw new SystemError(E.IO);
    offset += written;
  }
}

function* prefixes(path: string): Generator<string> {
  const parts = path.split("/");
  let accumulated = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "") {
      if (i === 0) accumulated = "/"; // absolute path root
      continue;
    }
    accumulated =
      accumulated === "" || accumulated === "/" ? accumulated + part : `${accumulated}/${part}`;
    yield accumulated;
  }
}

class GuestClient {
  #session: Promise<GuestSession> | null = null;
  #processes = 0;
  #process_waiters: (() => void)[] = [];

  constructor(private readonly vsock: VsockDevice) {}

  // Lazy, memoized connect; cleared on failure so the next call retries. This
  // is what machine.ts's readiness loop depends on.
  #connect(timeoutMs?: number): Promise<GuestSession> {
    if (!this.#session) {
      const attempt = GuestSession.connect(
        this.vsock,
        timeoutMs !== undefined ? { timeoutMs } : undefined,
      ).catch((error: unknown) => {
        if (this.#session === attempt) this.#session = null;
        throw error;
      });
      this.#session = attempt;
    }
    return this.#session;
  }

  async ping(timeoutMs = 5000) {
    await getpid(await this.#connect(timeoutMs));
  }

  async readFile(path: string, options: { signal?: AbortSignal } = {}) {
    const session = await this.#connect();
    options.signal?.throwIfAborted();
    await using fd = await openat(session, path, O.RDONLY | O.CLOEXEC, 0);
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const data = await read(fd, CHUNK);
      if (data.byteLength === 0) break;
      chunks.push(data);
      length += data.byteLength;
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  async readTextFile(path: string, options: { signal?: AbortSignal } = {}) {
    return new TextDecoder("utf-8", { fatal: true }).decode(await this.readFile(path, options));
  }

  async writeFile(path: string, data: FileData, options: WriteFileOptions = {}) {
    const session = await this.#connect();
    options.signal?.throwIfAborted();
    let flags = O.WRONLY;
    if (options.create ?? true) flags |= O.CREAT;
    if (options.createNew) flags |= O.CREAT | O.EXCL;
    if (options.append) flags |= O.APPEND;
    else flags |= O.TRUNC;
    await using fd = await openat(session, path, flags, options.mode ?? 0o666);

    const reader = byte_stream(data).getReader();
    let remove_abort = () => {};
    try {
      if (options.signal) {
        const abort = () => {
          void reader.cancel(options.signal?.reason).catch(() => {});
        };
        options.signal.addEventListener("abort", abort, { once: true });
        remove_abort = () => options.signal?.removeEventListener("abort", abort);
        if (options.signal.aborted) abort();
      }
      for (;;) {
        options.signal?.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        await write_all(fd, value, options.signal);
      }
      // A cancelled reader resolves `done`; ensure abort still rejects.
      options.signal?.throwIfAborted();
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      options.signal?.throwIfAborted();
      throw error;
    } finally {
      remove_abort();
      reader.releaseLock();
    }
  }

  writeTextFile(
    path: string,
    data: string | ReadableStream<string>,
    options: WriteFileOptions = {},
  ) {
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data.pipeThrough(new TextEncoderStream());
    return this.writeFile(path, bytes, options);
  }

  async *readDir(path: string): AsyncIterable<DirEntry> {
    const session = await this.#connect();
    await using fd = await openat(session, path, O.RDONLY | O.DIRECTORY | O.CLOEXEC, 0);
    for (;;) {
      const buffer = await getdents64(fd, CHUNK);
      if (buffer.byteLength === 0) break;
      for (const { name, dtype } of parse_dirents(buffer)) {
        yield {
          name,
          isFile: dtype === DT.REG,
          isDirectory: dtype === DT.DIR,
          isSymlink: dtype === DT.LNK,
        };
      }
    }
  }

  async stat(path: string) {
    return statToInfo(await fstatat64(await this.#connect(), path, 0));
  }

  async lstat(path: string) {
    return statToInfo(await fstatat64(await this.#connect(), path, AT.SYMLINK_NOFOLLOW));
  }

  async mkdir(path: string, options: MkdirOptions = {}) {
    const session = await this.#connect();
    const mode = options.mode ?? 0o777;
    if (!options.recursive) {
      await mkdirat(session, path, mode);
      return;
    }
    for (const prefix of prefixes(path)) {
      try {
        await mkdirat(session, prefix, mode);
      } catch (error) {
        if (error instanceof SystemError && error.code === "EEXIST") continue;
        const info = await fstatat64(session, prefix, 0);
        if (!statToInfo(info).isDirectory) {
          throw new SystemError(E.NOTDIR);
        }
      }
    }
  }

  async remove(path: string, options: { recursive?: boolean } = {}) {
    if (options.recursive) return this.#remove_recursive(path);
    await this.#unlink(await this.#connect(), path);
  }

  async #unlink(session: GuestSession, path: string) {
    try {
      await unlinkat(session, path, 0);
    } catch (error) {
      if (!(error instanceof SystemError && (error.code === "EISDIR" || error.code === "EPERM")))
        throw error;
      await unlinkat(session, path, AT.REMOVEDIR);
    }
  }

  async #remove_recursive(path: string) {
    const info = await this.lstat(path);
    const session = await this.#connect();
    if (!info.isDirectory) {
      await this.#unlink(session, path);
      return;
    }
    const names: string[] = [];
    for await (const entry of this.readDir(path)) names.push(entry.name);
    for (const name of names) await this.#remove_recursive(`${path}/${name}`);
    await unlinkat(session, path, AT.REMOVEDIR);
  }

  async rename(from: string, to: string) {
    await renameat(await this.#connect(), from, to);
  }

  async copyFile(from: string, to: string) {
    const session = await this.#connect();
    const src = await this.stat(from);
    let dst: FileInfo | null = null;
    try {
      dst = await this.stat(to);
    } catch (error) {
      if (!(error instanceof SystemError && error.code === "ENOENT")) throw error;
    }
    if (dst && dst.dev === src.dev && dst.ino === src.ino) {
      throw new SystemError(E.INVAL);
    }
    await using src_fd = await openat(session, from, O.RDONLY, 0);
    await using dst_fd = await openat(session, to, O.WRONLY | O.CREAT, 0o666);
    await ftruncate64(dst_fd, 0n);
    for (;;) {
      const data = await read(src_fd, CHUNK);
      if (data.byteLength === 0) break;
      await write_all(dst_fd, data);
    }
  }

  async realPath(path: string) {
    const session = await this.#connect();
    await using fd = await openat(session, path, O.PATH | O.CLOEXEC, 0);
    const target = await readlinkat(session, `/proc/self/fd/${fd.fd}`, 4096);
    return new TextDecoder("utf-8", { fatal: true }).decode(target);
  }

  async readLink(path: string) {
    const target = await readlinkat(await this.#connect(), path, 4096);
    if (target.byteLength === 4096) throw new SystemError(E.NAMETOOLONG);
    return new TextDecoder("utf-8", { fatal: true }).decode(target);
  }

  async symlink(target: string, path: string) {
    await symlinkat(await this.#connect(), target, path);
  }

  async chmod(path: string, mode: number) {
    await fchmodat(await this.#connect(), path, mode);
  }

  async chown(path: string, uid: number, gid: number) {
    await fchownat(await this.#connect(), path, uid, gid);
  }

  async truncate(path: string, length = 0) {
    const session = await this.#connect();
    await using fd = await openat(session, path, O.WRONLY, 0);
    await ftruncate64(fd, BigInt(length));
  }

  async open(path: string, options: OpenOptions = {}) {
    const session = await this.#connect();
    return new FsFile(await openat(session, path, openFlags(options), options.mode ?? 0o666));
  }

  #acquire_process_slot(): Promise<() => void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const waiter = this.#process_waiters.shift();
      if (waiter) waiter();
      else this.#processes--;
    };
    if (this.#processes < MAX_PROCESSES) {
      this.#processes++;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => this.#process_waiters.push(() => resolve(release)));
  }

  async exec(argv: readonly string[], options: ExecOptions = {}) {
    if (!argv.length) throw new TypeError("exec argv must not be empty");
    options.signal?.throwIfAborted();
    const session = await this.#connect();
    options.signal?.throwIfAborted();
    const environment = {
      PATH: "/bin:/usr/bin:/sbin:/usr/sbin",
      HOME: "/workspace",
      TMPDIR: "/tmp",
      ...options.env,
    };
    const env = Object.entries(environment).map(([key, value]) => `${key}=${value}`);
    const release = await this.#acquire_process_slot();
    try {
      const spawned = await spawn(session, argv, options.cwd ?? "/workspace", env);
      return new ChildProcess({
        session,
        ...spawned,
        signal: options.signal,
        release,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}

export function createGuestClient(vsock: VsockDevice): GuestClientCapabilities {
  const client = new GuestClient(vsock);
  return {
    ping: client.ping.bind(client),
    fs: {
      readFile: client.readFile.bind(client),
      readTextFile: client.readTextFile.bind(client),
      writeFile: client.writeFile.bind(client),
      writeTextFile: client.writeTextFile.bind(client),
      readDir: client.readDir.bind(client),
      stat: client.stat.bind(client),
      lstat: client.lstat.bind(client),
      mkdir: client.mkdir.bind(client),
      remove: client.remove.bind(client),
      rename: client.rename.bind(client),
      copyFile: client.copyFile.bind(client),
      realPath: client.realPath.bind(client),
      readLink: client.readLink.bind(client),
      symlink: client.symlink.bind(client),
      chmod: client.chmod.bind(client),
      chown: client.chown.bind(client),
      truncate: client.truncate.bind(client),
      open: client.open.bind(client),
    },
    exec: client.exec.bind(client),
  };
}
