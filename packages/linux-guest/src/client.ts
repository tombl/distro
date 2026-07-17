import type { VsockDevice } from "@tombl/linux";
import { AT, DT, NR, O, parseDirents, statSize } from "./abi.ts";
import { GuestConn } from "./conn.ts";
import { ProtocolError, SystemError } from "./errors.ts";
import {
  CHUNK,
  closeFd,
  cString,
  decodeStat,
  type DirEntry,
  type FileInfo,
  FsFile,
  loHi,
  type MkdirOptions,
  openFd,
  openFlags,
  type OpenOptions,
  sys,
  type WriteFileOptions,
} from "./file.ts";
import { ChildProcess } from "./process.ts";

// POSIX errno numbers used for control flow (not part of the guest ABI schema
// in abi.ts, which owns kernel structure/flag layouts, not error codes).
const ENOENT = 2;
const EEXIST = 17;
const ENOTDIR = 20;
const EISDIR = 21;
const EPERM = 1;
const EINVAL = 22;
const ENAMETOOLONG = 36;

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

function byteStream(data: FileData): ReadableStream<Uint8Array> {
  if (data instanceof ReadableStream) return data;
  if (data instanceof Blob) return data.stream();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

// Write `data` fully in <=32 KiB chunks, tolerating short writes.
async function writeAll(
  conn: GuestConn,
  fd: number,
  data: Uint8Array,
  path: string,
  signal?: AbortSignal,
) {
  let offset = 0;
  while (offset < data.byteLength) {
    signal?.throwIfAborted();
    const chunk = data.subarray(offset, offset + CHUNK);
    const result = await sys(conn, NR.write, "write", [fd, { in: chunk }, chunk.byteLength], path);
    const written = Number(result.ret);
    if (written <= 0) throw new ProtocolError("guest write made no progress");
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
  #conn: Promise<GuestConn> | null = null;

  constructor(private readonly vsock: VsockDevice) {}

  // Lazy, memoized connect; cleared on failure so the next call retries. This
  // is what machine.ts's readiness loop depends on.
  #connect(timeoutMs?: number): Promise<GuestConn> {
    if (!this.#conn) {
      const attempt = GuestConn.connect(
        this.vsock,
        timeoutMs !== undefined ? { timeoutMs } : undefined,
      ).catch((error: unknown) => {
        if (this.#conn === attempt) this.#conn = null;
        throw error;
      });
      this.#conn = attempt;
    }
    return this.#conn;
  }

  async ping(timeoutMs = 5000) {
    const conn = await this.#connect(timeoutMs);
    const result = await conn.syscall(NR.getpid);
    if (result.ret === -1n) throw new SystemError(result.errno, "getpid");
  }

  async readFile(path: string, options: { signal?: AbortSignal } = {}) {
    const conn = await this.#connect();
    options.signal?.throwIfAborted();
    const fd = await openFd(conn, path, O.RDONLY | O.CLOEXEC, 0);
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        options.signal?.throwIfAborted();
        const result = await sys(
          conn,
          NR.read,
          "read",
          [fd, { out: CHUNK, retSized: true }, CHUNK],
          path,
        );
        if (result.ret === 0n) break;
        chunks.push(result.out[0]!);
      }
      return concatBytes(chunks);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw error;
    } finally {
      await closeFd(conn, fd);
    }
  }

  async readTextFile(path: string, options: { signal?: AbortSignal } = {}) {
    return new TextDecoder("utf-8", { fatal: true }).decode(await this.readFile(path, options));
  }

  async writeFile(path: string, data: FileData, options: WriteFileOptions = {}) {
    const conn = await this.#connect();
    options.signal?.throwIfAborted();
    let flags = O.WRONLY;
    if (options.create ?? true) flags |= O.CREAT;
    if (options.createNew) flags |= O.CREAT | O.EXCL;
    if (options.append) flags |= O.APPEND;
    else flags |= O.TRUNC;
    const fd = await openFd(conn, path, flags, options.mode ?? 0o666);

    const reader = byteStream(data).getReader();
    let removeAbort = () => {};
    try {
      if (options.signal) {
        const abort = () => {
          void reader.cancel(options.signal?.reason).catch(() => {});
        };
        options.signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => options.signal?.removeEventListener("abort", abort);
        if (options.signal.aborted) abort();
      }
      for (;;) {
        options.signal?.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        await writeAll(conn, fd, value, path, options.signal);
      }
      // A cancelled reader resolves `done`; ensure abort still rejects (v1).
      options.signal?.throwIfAborted();
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      options.signal?.throwIfAborted();
      throw error;
    } finally {
      removeAbort();
      reader.releaseLock();
      await closeFd(conn, fd);
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
    const conn = await this.#connect();
    const fd = await openFd(conn, path, O.RDONLY | O.DIRECTORY | O.CLOEXEC, 0);
    try {
      for (;;) {
        const result = await sys(
          conn,
          NR.getdents64,
          "readdir",
          [fd, { out: CHUNK, retSized: true }, CHUNK],
          path,
        );
        if (result.ret === 0n) break;
        for (const { name, dtype } of parseDirents(result.out[0]!)) {
          yield {
            name,
            isFile: dtype === DT.REG,
            isDirectory: dtype === DT.DIR,
            isSymlink: dtype === DT.LNK,
          };
        }
      }
    } finally {
      await closeFd(conn, fd);
    }
  }

  stat(path: string) {
    return this.#stat(path, true);
  }

  lstat(path: string) {
    return this.#stat(path, false);
  }

  async #stat(path: string, follow: boolean): Promise<FileInfo> {
    const conn = await this.#connect();
    const result = await sys(
      conn,
      NR.fstatat64,
      follow ? "stat" : "lstat",
      [AT.FDCWD, cString(path), { out: statSize }, follow ? 0 : AT.SYMLINK_NOFOLLOW],
      path,
    );
    return decodeStat(result.out[0]!);
  }

  async mkdir(path: string, options: MkdirOptions = {}) {
    const conn = await this.#connect();
    const mode = options.mode ?? 0o777;
    if (!options.recursive) {
      await sys(conn, NR.mkdirat, "mkdir", [AT.FDCWD, cString(path), mode], path);
      return;
    }
    for (const prefix of prefixes(path)) {
      const result = await conn.syscall(NR.mkdirat, AT.FDCWD, cString(prefix), mode);
      if (result.ret === -1n) {
        if (result.errno !== EEXIST) {
          throw new SystemError(result.errno, "mkdir", prefix);
        }
        const info = await sys(
          conn,
          NR.fstatat64,
          "mkdir",
          [AT.FDCWD, cString(prefix), { out: statSize }, 0],
          prefix,
        );
        if (!decodeStat(info.out[0]!).isDirectory) {
          throw new SystemError(ENOTDIR, "mkdir", prefix);
        }
      }
    }
  }

  async remove(path: string, options: { recursive?: boolean } = {}) {
    if (options.recursive) return this.#removeRecursive(path);
    const conn = await this.#connect();
    await this.#unlink(conn, path);
  }

  async #unlink(conn: GuestConn, path: string) {
    const result = await conn.syscall(NR.unlinkat, AT.FDCWD, cString(path), 0);
    if (result.ret === -1n) {
      if (result.errno === EISDIR || result.errno === EPERM) {
        await sys(conn, NR.unlinkat, "remove", [AT.FDCWD, cString(path), AT.REMOVEDIR], path);
        return;
      }
      throw new SystemError(result.errno, "remove", path);
    }
  }

  async #removeRecursive(path: string) {
    const info = await this.lstat(path);
    const conn = await this.#connect();
    if (!info.isDirectory) {
      await this.#unlink(conn, path);
      return;
    }
    const names: string[] = [];
    for await (const entry of this.readDir(path)) names.push(entry.name);
    for (const name of names) await this.#removeRecursive(`${path}/${name}`);
    await sys(conn, NR.unlinkat, "remove", [AT.FDCWD, cString(path), AT.REMOVEDIR], path);
  }

  async rename(from: string, to: string) {
    const conn = await this.#connect();
    await sys(
      conn,
      NR.renameat,
      "rename",
      [AT.FDCWD, cString(from), AT.FDCWD, cString(to)],
      from,
      to,
    );
  }

  async copyFile(from: string, to: string) {
    const conn = await this.#connect();
    const src = await this.stat(from);
    let dst: FileInfo | null = null;
    try {
      dst = await this.stat(to);
    } catch (error) {
      if (!(error instanceof SystemError && error.errno === ENOENT)) throw error;
    }
    if (dst && dst.dev === src.dev && dst.ino === src.ino) {
      throw new SystemError(EINVAL, "copy", from, to);
    }
    const srcFd = await openFd(conn, from, O.RDONLY, 0, to);
    let dstFd = -1;
    try {
      dstFd = await openFd(conn, to, O.WRONLY | O.CREAT, 0o666, to);
      await sys(conn, NR.ftruncate64, "copy", [dstFd, 0, 0], to);
      for (;;) {
        const result = await sys(
          conn,
          NR.read,
          "copy",
          [srcFd, { out: CHUNK, retSized: true }, CHUNK],
          from,
        );
        if (result.ret === 0n) break;
        await writeAll(conn, dstFd, result.out[0]!, to);
      }
    } finally {
      await closeFd(conn, srcFd);
      if (dstFd !== -1) await closeFd(conn, dstFd);
    }
  }

  async realPath(path: string) {
    const conn = await this.#connect();
    const fd = await openFd(conn, path, O.PATH | O.CLOEXEC, 0);
    try {
      const result = await sys(
        conn,
        NR.readlinkat,
        "realpath",
        [AT.FDCWD, cString(`/proc/self/fd/${fd}`), { out: 4096, retSized: true }, 4096],
        path,
      );
      return new TextDecoder("utf-8", { fatal: true }).decode(result.out[0]!);
    } finally {
      await closeFd(conn, fd);
    }
  }

  async readLink(path: string) {
    const conn = await this.#connect();
    const result = await sys(
      conn,
      NR.readlinkat,
      "readlink",
      [AT.FDCWD, cString(path), { out: 4096, retSized: true }, 4096],
      path,
    );
    if (result.ret === 4096n) throw new SystemError(ENAMETOOLONG, "readlink", path);
    return new TextDecoder("utf-8", { fatal: true }).decode(result.out[0]!);
  }

  async symlink(target: string, path: string) {
    const conn = await this.#connect();
    await sys(
      conn,
      NR.symlinkat,
      "symlink",
      [cString(target), AT.FDCWD, cString(path)],
      path,
      target,
    );
  }

  async chmod(path: string, mode: number) {
    const conn = await this.#connect();
    await sys(conn, NR.fchmodat, "chmod", [AT.FDCWD, cString(path), mode, 0], path);
  }

  async chown(path: string, uid: number, gid: number) {
    const conn = await this.#connect();
    await sys(conn, NR.fchownat, "chown", [AT.FDCWD, cString(path), uid, gid, 0], path);
  }

  async truncate(path: string, length = 0) {
    const conn = await this.#connect();
    const fd = await openFd(conn, path, O.WRONLY, 0);
    try {
      const [lo, hi] = loHi(BigInt(length));
      await sys(conn, NR.ftruncate64, "truncate", [fd, lo, hi], path);
    } finally {
      await closeFd(conn, fd);
    }
  }

  async open(path: string, options: OpenOptions = {}) {
    const conn = await this.#connect();
    const fd = await openFd(conn, path, openFlags(options), options.mode ?? 0o666);
    return new FsFile(conn, fd, path);
  }

  async exec(argv: readonly string[], options: ExecOptions = {}) {
    if (!argv.length) throw new TypeError("exec argv must not be empty");
    options.signal?.throwIfAborted();
    const conn = await this.#connect();
    options.signal?.throwIfAborted();
    const environment = {
      PATH: "/bin:/usr/bin:/sbin:/usr/sbin",
      HOME: "/workspace",
      TMPDIR: "/tmp",
      ...options.env,
    };
    const env = Object.entries(environment).map(([key, value]) => `${key}=${value}`);
    const result = await conn.spawn(argv, options.cwd ?? "/workspace", env);
    if (result.ret === -1n) throw new SystemError(result.errno, "posix_spawnp");
    return new ChildProcess({
      conn,
      pid: result.pid,
      stdinFd: result.stdin,
      stdoutFd: result.stdout,
      stderrFd: result.stderr,
      signal: options.signal,
    });
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
