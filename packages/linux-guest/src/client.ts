import type { VsockDevice } from "@tombl/linux";
import {
  decodeDirEntry,
  decodeFileInfo,
  type DirEntry,
  type FileInfo,
  FsFile,
  type MkdirOptions,
  openFlags,
  type OpenOptions,
  type WriteFileOptions,
} from "./file.ts";
import { ChildProcess } from "./process.ts";
import {
  abortConnection,
  concat,
  connect,
  ConnectionKind,
  expectEnd,
  maxFramePayload,
  MessageType,
  readFrame,
  readU32,
  readU64,
  string,
  strings,
  throwIfError,
  u32,
  u64,
  writeFrame,
} from "./protocol.ts";
import { ProtocolError } from "./errors.ts";

export type FileData = Uint8Array | Blob | ReadableStream<Uint8Array>;

export interface ExecOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface FileSystem {
  readFile(
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<Uint8Array>;
  readTextFile(
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<string>;
  writeFile(
    path: string,
    data: FileData,
    options?: WriteFileOptions,
  ): Promise<void>;
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

export type Exec = (
  argv: readonly string[],
  options?: ExecOptions,
) => Promise<ChildProcess>;

export interface GuestClientCapabilities {
  ping(timeoutMs?: number): Promise<void>;
  readonly fs: FileSystem;
  readonly exec: Exec;
}

function byteStream(data: FileData) {
  if (data instanceof ReadableStream) return data;
  if (data instanceof Blob) return data.stream();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

class GuestClient {
  constructor(private readonly vsock: VsockDevice) {}

  async ping(timeoutMs = 5000) {
    const connection = await connect(
      this.vsock,
      ConnectionKind.Ping,
      new Uint8Array(),
      timeoutMs,
    );
    try {
      const frame = await readFrame(connection);
      throwIfError(frame, "ping");
      if (
        frame.type !== MessageType.Data ||
        new TextDecoder().decode(frame.payload) !== "pong"
      ) {
        throw new ProtocolError("invalid ping response");
      }
      await expectEnd(connection, "ping");
    } finally {
      connection.close();
    }
  }

  async readFile(path: string, options: { signal?: AbortSignal } = {}) {
    const connection = await connect(
      this.vsock,
      ConnectionKind.ReadFile,
      string(path),
    );
    let removeAbort = () => {};
    const chunks: Uint8Array[] = [];
    try {
      removeAbort = abortConnection(connection, options.signal);
      for (;;) {
        const frame = await readFrame(connection);
        throwIfError(frame, "read", path);
        if (frame.type === MessageType.End) break;
        if (frame.type !== MessageType.Data) {
          throw new ProtocolError("invalid readFile response");
        }
        chunks.push(frame.payload);
      }
      return concat(chunks);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw error;
    } finally {
      removeAbort();
      connection.close();
    }
  }

  async readTextFile(path: string, options: { signal?: AbortSignal } = {}) {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.readFile(path, options),
    );
  }

  async writeFile(
    path: string,
    data: FileData,
    options: WriteFileOptions = {},
  ) {
    const flags = ((options.create ?? true) ? 1 : 0) |
      (options.createNew ? 2 : 0) |
      (options.append ? 4 : 0) |
      (!options.append ? 8 : 0);
    const metadata = concat([
      string(path),
      u32(flags),
      u32(options.mode ?? 0o666),
    ]);
    const connection = await connect(
      this.vsock,
      ConnectionKind.WriteFile,
      metadata,
    );
    const reader = byteStream(data).getReader();
    let removeAbort = () => {};
    try {
      options.signal?.throwIfAborted();
      if (options.signal) {
        const abort = () => {
          connection.close();
          void reader.cancel(options.signal?.reason).catch(() => {});
        };
        options.signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => options.signal?.removeEventListener("abort", abort);
        if (options.signal.aborted) abort();
      }
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (
          let offset = 0;
          offset < value.byteLength;
          offset += maxFramePayload
        ) {
          await writeFrame(
            connection,
            MessageType.Data,
            value.subarray(offset, offset + maxFramePayload),
          );
        }
      }
      await writeFrame(connection, MessageType.End);
      await expectEnd(connection, "write", path);
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      options.signal?.throwIfAborted();
      throw error;
    } finally {
      removeAbort();
      connection.close();
      reader.releaseLock();
    }
  }

  writeTextFile(
    path: string,
    data: string | ReadableStream<string>,
    options: WriteFileOptions = {},
  ) {
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data.pipeThrough(new TextEncoderStream());
    return this.writeFile(path, bytes, options);
  }

  async *readDir(path: string): AsyncIterable<DirEntry> {
    const connection = await connect(
      this.vsock,
      ConnectionKind.ReadDir,
      string(path),
    );
    try {
      for (;;) {
        const frame = await readFrame(connection);
        throwIfError(frame, "readdir", path);
        if (frame.type === MessageType.End) break;
        if (frame.type !== MessageType.Entry) {
          throw new ProtocolError("invalid readDir response");
        }
        yield decodeDirEntry(frame.payload);
      }
    } finally {
      connection.close();
    }
  }

  stat(path: string) {
    return this.#stat(path, true);
  }

  lstat(path: string) {
    return this.#stat(path, false);
  }

  async #stat(path: string, follow: boolean): Promise<FileInfo> {
    const connection = await connect(
      this.vsock,
      follow ? ConnectionKind.Stat : ConnectionKind.Lstat,
      string(path),
    );
    try {
      const frame = await readFrame(connection);
      throwIfError(frame, follow ? "stat" : "lstat", path);
      if (frame.type !== MessageType.Data) {
        throw new ProtocolError("invalid stat response");
      }
      const info = decodeFileInfo(frame.payload);
      await expectEnd(connection, follow ? "stat" : "lstat", path);
      return info;
    } finally {
      connection.close();
    }
  }

  mkdir(path: string, options: MkdirOptions = {}) {
    return this.#end(
      ConnectionKind.Mkdir,
      concat([
        string(path),
        u32(options.recursive ? 1 : 0),
        u32(options.mode ?? 0o777),
      ]),
      "mkdir",
      path,
    );
  }

  remove(path: string, options: { recursive?: boolean } = {}) {
    return this.#end(
      ConnectionKind.Remove,
      concat([string(path), u32(options.recursive ? 1 : 0)]),
      "remove",
      path,
    );
  }

  rename(from: string, to: string) {
    return this.#end(
      ConnectionKind.Rename,
      concat([string(from), string(to)]),
      "rename",
      from,
      to,
    );
  }

  copyFile(from: string, to: string) {
    return this.#end(
      ConnectionKind.CopyFile,
      concat([string(from), string(to)]),
      "copy",
      from,
      to,
    );
  }

  async realPath(path: string) {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.#data(ConnectionKind.RealPath, string(path), "realpath", path),
    );
  }

  async readLink(path: string) {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.#data(ConnectionKind.ReadLink, string(path), "readlink", path),
    );
  }

  symlink(target: string, path: string) {
    return this.#end(
      ConnectionKind.Symlink,
      concat([string(target), string(path)]),
      "symlink",
      path,
      target,
    );
  }

  chmod(path: string, mode: number) {
    return this.#end(
      ConnectionKind.Chmod,
      concat([string(path), u32(mode)]),
      "chmod",
      path,
    );
  }

  chown(path: string, uid: number, gid: number) {
    return this.#end(
      ConnectionKind.Chown,
      concat([string(path), u32(uid), u32(gid)]),
      "chown",
      path,
    );
  }

  truncate(path: string, length = 0) {
    return this.#end(
      ConnectionKind.Truncate,
      concat([string(path), u64(length)]),
      "truncate",
      path,
    );
  }

  async open(path: string, options: OpenOptions = {}) {
    const connection = await connect(
      this.vsock,
      ConnectionKind.OpenFile,
      concat([
        string(path),
        u32(openFlags(options)),
        u32(options.mode ?? 0o666),
      ]),
    );
    try {
      await expectEnd(connection, "open", path);
      return new FsFile(connection, path);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async exec(argv: readonly string[], options: ExecOptions = {}) {
    if (!argv.length) throw new TypeError("exec argv must not be empty");
    options.signal?.throwIfAborted();
    const environment = {
      PATH: "/bin:/usr/bin:/sbin:/usr/sbin",
      HOME: "/workspace",
      TMPDIR: "/tmp",
      ...options.env,
    };
    const metadata = concat([
      strings(argv),
      string(options.cwd ?? "/workspace"),
      strings(
        Object.entries(environment).map(([key, value]) => `${key}=${value}`),
      ),
    ]);
    const control = await connect(
      this.vsock,
      ConnectionKind.ExecControl,
      metadata,
    );
    const connections: Array<Awaited<ReturnType<typeof connect>>> = [control];
    try {
      options.signal?.throwIfAborted();
      const tokenFrame = await readFrame(control);
      throwIfError(tokenFrame, "posix_spawnp");
      if (
        tokenFrame.type !== MessageType.Data ||
        tokenFrame.payload.byteLength !== 8
      ) {
        throw new ProtocolError("invalid process token");
      }
      const token = u64(readU64(tokenFrame.payload));
      const input = await connect(this.vsock, ConnectionKind.ExecStdin, token);
      connections.push(input);
      const output = await connect(
        this.vsock,
        ConnectionKind.ExecStdout,
        token,
      );
      connections.push(output);
      const error = await connect(this.vsock, ConnectionKind.ExecStderr, token);
      connections.push(error);
      await Promise.all([
        expectEnd(input, "attach stdin"),
        expectEnd(output, "attach stdout"),
        expectEnd(error, "attach stderr"),
      ]);
      await writeFrame(control, MessageType.Start);
      const started = await readFrame(control);
      throwIfError(started, "posix_spawnp");
      if (
        started.type !== MessageType.Data || started.payload.byteLength !== 4
      ) {
        throw new ProtocolError("invalid process start response");
      }
      options.signal?.throwIfAborted();
      return new ChildProcess(
        readU32(started.payload),
        control,
        input,
        output,
        error,
        options.signal,
      );
    } catch (error) {
      for (const connection of connections) connection.close();
      options.signal?.throwIfAborted();
      throw error;
    }
  }

  async #end(
    kind: number,
    metadata: Uint8Array,
    syscall: string,
    path?: string,
    destination?: string,
  ) {
    const connection = await connect(this.vsock, kind, metadata);
    try {
      await expectEnd(connection, syscall, path, destination);
    } finally {
      connection.close();
    }
  }

  async #data(
    kind: number,
    metadata: Uint8Array,
    syscall: string,
    path?: string,
  ) {
    const connection = await connect(this.vsock, kind, metadata);
    try {
      const frame = await readFrame(connection);
      throwIfError(frame, syscall, path);
      if (frame.type !== MessageType.Data) {
        throw new ProtocolError(`invalid ${syscall} response`);
      }
      await expectEnd(connection, syscall, path);
      return frame.payload;
    } finally {
      connection.close();
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
