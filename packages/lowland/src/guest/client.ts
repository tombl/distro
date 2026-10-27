// The public API, composed entirely from the syscall table.
// Every operation here reads like the C it replaces; errno-based control
// flow catches SystemError, because exceptions are the errno channel.

import type { VsockDevice } from "../machine/virtio/vsock.ts";
import { AT, DT, E, O, parse_dirents, RESOLVE, SystemError } from "./abi.ts";
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
  mkdirat_in,
  mount,
  openat,
  openat2,
  read,
  read_kernel_log,
  readlinkat,
  renameat,
  signal_init,
  switch_root,
  symlinkat,
  sync,
  unlinkat,
  umount2,
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
import {
  ChildProcess,
  spawn_stdio,
  spawn_terminal,
  type Stdio,
  type StdioSpec,
  type TerminalSize,
} from "./process.ts";

/** Data that can be written to a guest file: bytes, a `Blob`, or a stream of bytes. */
export type FileData = Uint8Array | Blob | ReadableStream<Uint8Array>;

export interface SpawnOptions {
  /** Working directory for the process. Defaults to `/`. */
  cwd?: string;
  /**
   * Environment for the process, merged over the defaults of
   * `PATH=/bin:/usr/bin:/sbin:/usr/sbin`, `HOME=/root`, and
   * `TMPDIR=/tmp`. Only the variables being changed need to be set.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Aborting kills the process, and `status` rejects with the abort reason.
   *
   * @example Give a command a time budget
   * ```ts
   * const process = await guest.spawn(["sleep", "30"], {
   *   signal: AbortSignal.timeout(1000),
   * });
   * try {
   *   await process.status;
   * } catch {
   *   console.log("the command ran out of time");
   * }
   * ```
   */
  signal?: AbortSignal;
  /**
   * Runs the process on a new guest pseudoterminal of this size, or 24 rows
   * by 80 columns for `true`, instead of on pipes. The process leads a new
   * session with the terminal as its controlling terminal, so shells enable
   * job control, `isatty` holds, and control characters written to `stdin`
   * reach the line discipline: `\x03` interrupts the foreground job and
   * `\x1a` suspends it. `ChildProcess.resize` changes the size later.
   *
   * @example Run an interactive shell
   * ```ts
   * const shell = await guest.spawn(["sh"], { terminal: { rows: 24, columns: 80 } });
   * void shell.stdout.pipeTo(output);
   * const input = shell.stdin.getWriter();
   * await input.write(new TextEncoder().encode("tty\n"));
   * ```
   *
   * A terminal is shorthand for standard descriptors of its own, so it
   * cannot be combined with `stdio`.
   */
  terminal?: boolean | TerminalSize;
  /**
   * What the process's standard input, output, and error are connected to.
   * Each defaults to `"pipe"`, a pipe to the matching `ChildProcess` stream.
   * `"null"` is `/dev/null`, `"stdout"` sends standard error wherever
   * standard output goes, like `2>&1`, and an `FsFile` from `guest.fs.open`
   * connects that guest file, which the process shares with you, offset and
   * all. A stream whose descriptor is not a pipe has nothing behind it:
   * `stdout` and `stderr` are empty, writes to `stdin` reject, and closing
   * `stdin` does nothing, neither closing the file nor ending the process's
   * input.
   *
   * The process gets its own reference to a file, so you can close the
   * `FsFile` once `exec` resolves.
   *
   * @example Collect errors with the output, with no input
   * ```ts
   * const build = await guest.run(["make"], { stdio: ["null", "pipe", "stdout"] });
   * console.log(new TextDecoder().decode(build.stdout));
   * ```
   *
   * @example Redirect a command to and from guest files
   * ```ts
   * await using input = await guest.fs.open("/tmp/in.txt");
   * await using output = await guest.fs.open("/tmp/out.txt", {
   *   write: true,
   *   create: true,
   *   truncate: true,
   * });
   * const sorted = await guest.spawn(["sort"], { stdio: [input, output, "pipe"] });
   * await sorted.status;
   * ```
   */
  stdio?: readonly [Exclude<StdioSpec, "stdout">, Exclude<StdioSpec, "stdout">, StdioSpec];
}

/** Options for `run()`: those of `spawn()`, plus the command's input. */
export interface RunOptions extends SpawnOptions {
  /**
   * What the command reads on standard input, as text or as data, after
   * which its input ends. Without it, the input ends at once. It needs
   * standard input to be a pipe.
   */
  input?: FileData | string;
}

const PIPES: Stdio = ["pipe", "pipe", "pipe"];

function stdio_of(options: SpawnOptions): Stdio {
  const { stdio } = options;
  if (stdio === undefined) return PIPES;
  if (options.terminal) throw new TypeError("spawn cannot combine `terminal` and `stdio`");
  if (!Array.isArray(stdio) || stdio.length !== 3) {
    throw new TypeError("spawn `stdio` must have three entries");
  }
  stdio.forEach((spec: unknown, fd) => {
    if (spec === "pipe" || spec === "null" || spec instanceof FsFile) return;
    if (spec === "stdout" && fd === 2) return;
    throw new TypeError(`spawn \`stdio[${fd}]\` cannot be ${String(spec)}`);
  });
  return stdio;
}

/**
 * File operations in the guest, available as `guest.fs`.
 *
 * Paths are guest paths. The packaged root image mounts writable space at
 * `/tmp`. The system directories are read-only. A failed
 * operation rejects with a `SystemError` carrying the errno code. For
 * example, a missing path returns `"ENOENT"`.
 */
export interface FileSystem {
  /** Reads the whole file into memory. */
  readFile(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  /** Reads the whole file as UTF-8 text. Throws on invalid UTF-8. */
  readTextFile(path: string, options?: { signal?: AbortSignal }): Promise<string>;
  /**
   * Writes data to a file, creating or truncating it by default. Accepts
   * bytes, a `Blob`, or a `ReadableStream`. Use a stream to move large data
   * into the guest without buffering all of it on the host.
   *
   * @example Copy a download straight into the guest
   * ```ts
   * const response = await fetch("https://example.com/big.tar.gz");
   * await guest.fs.writeFile("/tmp/big.tar.gz", response.body!);
   * ```
   */
  writeFile(path: string, data: FileData, options?: WriteFileOptions): Promise<void>;
  /** Writes text, or a stream of text, as UTF-8. */
  writeTextFile(
    path: string,
    data: string | ReadableStream<string>,
    options?: WriteFileOptions,
  ): Promise<void>;
  /**
   * Iterates the entries of a directory.
   *
   * @example List a directory
   * ```ts
   * for await (const entry of guest.fs.readDir("/bin")) {
   *   if (entry.isFile) console.log(entry.name);
   * }
   * ```
   */
  readDir(path: string): AsyncIterable<DirEntry>;
  /**
   * Returns the file's metadata, following symlinks. Rejects with a
   * `SystemError` whose code is `"ENOENT"` if the path does not exist.
   *
   * @example Check whether a path exists
   * ```ts
   * try {
   *   await guest.fs.stat("/tmp/maybe");
   *   console.log("it exists");
   * } catch (error) {
   *   if (error instanceof SystemError && error.code === "ENOENT") {
   *     console.log("it does not");
   *   } else {
   *     throw error;
   *   }
   * }
   * ```
   */
  stat(path: string): Promise<FileInfo>;
  /** Like `stat`, but does not follow the final symlink. */
  lstat(path: string): Promise<FileInfo>;
  /**
   * Creates a directory. With `recursive: true`, creates missing parents
   * and does not fail if the directory already exists.
   */
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  /**
   * Removes a file or an empty directory. With `recursive: true`, removes a
   * directory and everything in it.
   */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Renames or moves a file or directory. */
  rename(from: string, to: string): Promise<void>;
  /** Copies a file's contents. */
  copyFile(from: string, to: string): Promise<void>;
  /** Resolves symlinks and returns the canonical path. */
  realPath(path: string): Promise<string>;
  /** Returns the target of a symlink. */
  readLink(path: string): Promise<string>;
  /** Creates a symlink at `path` pointing at `target`. */
  symlink(target: string, path: string): Promise<void>;
  /** Changes a file's permission bits. */
  chmod(path: string, mode: number): Promise<void>;
  /** Changes a file's owner and group. */
  chown(path: string, uid: number, gid: number): Promise<void>;
  /** Truncates a file to `length` bytes, defaulting to empty. */
  truncate(path: string, length?: number): Promise<void>;
  /**
   * Writes every filesystem's cached data to its device, like `sync(1)`.
   * It needs no process, so it works even while commands hold every
   * process slot.
   */
  sync(): Promise<void>;
  /**
   * Opens a file for incremental or random-access I/O. The whole-file
   * methods above are simpler when you do not need either.
   *
   * @example Read and write at arbitrary offsets
   * ```ts
   * await using file = await guest.fs.open("/tmp/data.bin", {
   *   read: true,
   *   write: true,
   *   create: true,
   * });
   * await file.write(new Uint8Array([1, 2, 3]));
   * await file.seek(0, SeekMode.Start);
   * const buffer = new Uint8Array(3);
   * await file.read(buffer);
   * console.log(buffer); // [1, 2, 3]
   * ```
   */
  open(path: string, options?: OpenOptions): Promise<FsFile>;
}

export interface MountOptions {
  /** Filesystem type, such as `virtiofs`, `ext4`, or `tmpfs`. Omit for bind mounts. */
  type?: string;
  /** Linux mount flags. */
  flags?: number;
  /** Optional filesystem-specific mount data. */
  data?: string;
}

export type Mount = (
  source: string | null,
  target: string,
  options?: MountOptions,
) => Promise<void>;

export type Unmount = (target: string, options?: { flags?: number }) => Promise<void>;

export interface GuestClientCapabilities {
  ping(timeoutMs?: number): Promise<void>;
  /** Writes every dirty guest filesystem back to its storage. */
  sync(): Promise<void>;
  readonly fs: FileSystem;
  spawn(argv: readonly string[], options?: SpawnOptions): Promise<ChildProcess>;
  readonly mount: Mount;
  readonly unmount: Unmount;
  /**
   * Asks PID 1 to enter /sysroot, then start `init` there if given, and
   * ends the session: PID 1 switches between sessions, and the next call
   * connects a new one.
   */
  switch_root(init?: { argv: readonly string[]; env: readonly string[] }): Promise<void>;
  /** The end of the kernel log, as text. */
  kernel_log(): Promise<string>;
  /**
   * Sends `signal` to PID 1, over this client's session. Resolves `true`
   * once the request has gone out, even if the session ends before the
   * reply, and `false` if it could not be sent.
   */
  signal_init(signal: number): Promise<boolean>;
  /** Forgets the session, as when the guest has rebooted. */
  reset(): void;
  /**
   * Opens `path` as a directory with `root` as its `/`, creating missing
   * directories: symlinks, absolute or relative, and `..` never leave
   * `root`. The result is an `O_PATH` descriptor, which other calls on this
   * session name as `/proc/self/fd/N`.
   */
  open_directory_in(root: string, path: string): Promise<GuestFd>;
}

// A process may hold up to four blocked lanes (reap, stdout, stderr, one
// stdin write), so this cap keeps worst-case process traffic to half the
// 64-lane pool and everything else - notably the kill that unblocks a stuck
// pipe read - can always get a lane.
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
  #connected: GuestSession | null = null;
  #processes = 0;
  #process_waiters: (() => void)[] = [];
  private readonly vsock: VsockDevice;

  constructor(vsock: VsockDevice) {
    this.vsock = vsock;
  }

  // Lazy, memoized connect; cleared on failure so the next call retries, and
  // when the session dies, so a rebooted guest gets a new one. This is what
  // the agent's readiness loop depends on.
  #connect(timeoutMs?: number): Promise<GuestSession> {
    if (this.#connected?.dead) this.reset();
    if (!this.#session) {
      const attempt = GuestSession.connect(
        this.vsock,
        timeoutMs !== undefined ? { timeoutMs } : undefined,
      ).catch((error: unknown) => {
        if (this.#session === attempt) this.#session = null;
        throw error;
      });
      this.#session = attempt;
      void attempt.then(
        (session) => {
          if (this.#session === attempt) this.#connected = session;
        },
        () => {},
      );
    }
    return this.#session;
  }

  reset() {
    const session = this.#session;
    this.#session = null;
    this.#connected = null;
    void session?.then(
      (session) => session.close(),
      () => {},
    );
  }

  async signal_init(signal: number) {
    let session: GuestSession;
    try {
      session = await this.#connect();
    } catch {
      return false;
    }
    return signal_init(session, signal);
  }

  async ping(timeoutMs = 5000) {
    await getpid(await this.#connect(timeoutMs));
  }

  async sync() {
    await sync(await this.#connect());
  }

  async switch_root(init?: { argv: readonly string[]; env: readonly string[] }) {
    const pending = this.#connect();
    const session = await pending;
    await switch_root(session, init && { ...init, cwd: "/" });
    if (this.#session === pending) {
      this.#session = null;
      this.#connected = null;
    }
    session.close();
  }

  async open_directory_in(root: string, path: string) {
    const session = await this.#connect();
    const how = { flags: O.PATH | O.DIRECTORY | O.CLOEXEC, resolve: RESOLVE.IN_ROOT };
    const parts = path.split("/").filter(Boolean);
    await using root_fd = await openat(session, root, O.PATH | O.DIRECTORY | O.CLOEXEC, 0);
    const open = (count: number) =>
      openat2(session, root_fd, parts.slice(0, count).join("/") || ".", how);
    try {
      return await open(parts.length);
    } catch (error) {
      if (!(error instanceof SystemError && error.code === "ENOENT")) throw error;
    }
    // Something is missing: walk down, creating each missing directory in
    // the directory its parent resolved to.
    let parent = await open(0);
    try {
      for (let count = 1; count <= parts.length; count++) {
        let next: GuestFd;
        try {
          next = await open(count);
        } catch (error) {
          if (!(error instanceof SystemError && error.code === "ENOENT")) throw error;
          try {
            await mkdirat_in(parent, parts[count - 1]!, 0o755);
          } catch (error) {
            // A dangling symlink: opening it again fails honestly below.
            if (!(error instanceof SystemError && error.code === "EEXIST")) throw error;
          }
          next = await open(count);
        }
        await parent.close();
        parent = next;
      }
      return parent;
    } catch (error) {
      await parent.close();
      throw error;
    }
  }

  async kernel_log() {
    const log = await read_kernel_log(await this.#connect(), 4096);
    return new TextDecoder().decode(log);
  }

  async mount(source: string | null, target: string, options: MountOptions = {}) {
    await mount(
      await this.#connect(),
      source,
      target,
      options.type ?? null,
      options.flags ?? 0,
      options.data ?? null,
    );
  }

  async unmount(target: string, options: { flags?: number } = {}) {
    await umount2(await this.#connect(), target, options.flags ?? 0);
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
    let flags = O.WRONLY | O.CLOEXEC;
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
        if (!(error instanceof SystemError && error.code === "EEXIST")) throw error;
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
    await using src_fd = await openat(session, from, O.RDONLY | O.CLOEXEC, 0);
    await using dst_fd = await openat(session, to, O.WRONLY | O.CREAT | O.CLOEXEC, 0o666);
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
    await using fd = await openat(session, path, O.WRONLY | O.CLOEXEC, 0);
    await ftruncate64(fd, BigInt(length));
  }

  async open(path: string, options: OpenOptions = {}) {
    const session = await this.#connect();
    const flags = openFlags(options) | O.CLOEXEC;
    return new FsFile(await openat(session, path, flags, options.mode ?? 0o666));
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

  async spawn(argv: readonly string[], options: SpawnOptions = {}) {
    if (!argv.length) throw new TypeError("spawn argv must not be empty");
    const stdio = stdio_of(options);
    options.signal?.throwIfAborted();
    const session = await this.#connect();
    options.signal?.throwIfAborted();
    const environment = {
      PATH: "/bin:/usr/bin:/sbin:/usr/sbin",
      HOME: "/root",
      TMPDIR: "/tmp",
      ...options.env,
    };
    const env = Object.entries(environment).map(([key, value]) => `${key}=${value}`);
    const release = await this.#acquire_process_slot();
    try {
      const cwd = options.cwd ?? "/";
      const terminal = options.terminal === true ? { rows: 24, columns: 80 } : options.terminal;
      const spawned = terminal
        ? await spawn_terminal(session, argv, cwd, env, terminal)
        : await spawn_stdio(session, argv, cwd, env, stdio);
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

export function create_guest_client(vsock: VsockDevice): GuestClientCapabilities {
  const client = new GuestClient(vsock);
  return {
    ping: client.ping.bind(client),
    sync: client.sync.bind(client),
    switch_root: client.switch_root.bind(client),
    kernel_log: client.kernel_log.bind(client),
    signal_init: client.signal_init.bind(client),
    reset: client.reset.bind(client),
    open_directory_in: client.open_directory_in.bind(client),
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
      sync: client.sync.bind(client),
      open: client.open.bind(client),
    },
    spawn: client.spawn.bind(client),
    mount: client.mount.bind(client),
    unmount: client.unmount.bind(client),
  };
}
