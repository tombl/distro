// SPDX-License-Identifier: MIT

import {
  type FS as FileSystemBackend,
  type FSAttributes,
  type FSCreateContext,
  type FSDirectoryEntry,
  FSError,
  type FSSetAttributes,
  type FSStat,
} from "@tombl/linux";
import { constants, type BigIntStats } from "node:fs";
import {
  access,
  chmod,
  lchown,
  lstat,
  lutimes,
  mkdir,
  open,
  type FileHandle,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  statfs,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const known_errors = new Set([
  "EACCES",
  "EBADF",
  "EEXIST",
  "EINVAL",
  "EIO",
  "EISDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOSPC",
  "ENOSYS",
  "ENOTDIR",
  "ENOTEMPTY",
  "EOPNOTSUPP",
  "EPERM",
  "EROFS",
]);

function filesystem_error(error: unknown): never {
  if (error instanceof FSError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code && known_errors.has(code)) {
    throw new FSError(code as ConstructorParameters<typeof FSError>[0], (error as Error).message);
  }
  throw new FSError("EIO", error instanceof Error ? error.message : String(error));
}

async function node_call<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    filesystem_error(error);
  }
}

function valid_name(name: string) {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0") ||
    name.includes(path.sep)
  ) {
    throw new FSError("EINVAL", "invalid path component");
  }
  return name;
}

function seconds(nanoseconds: bigint) {
  return {
    seconds: nanoseconds / 1_000_000_000n,
    nanoseconds: Number(nanoseconds % 1_000_000_000n),
  };
}

function attributes(stats: BigIntStats): FSAttributes {
  return {
    mode: Number(stats.mode),
    size: stats.size,
    blocks: stats.blocks,
    nlink: Number(stats.nlink),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    rdev: Number(stats.rdev),
    blockSize: Number(stats.blksize),
    atime: seconds(stats.atimeNs),
    mtime: seconds(stats.mtimeNs),
    ctime: seconds(stats.ctimeNs),
  };
}

function checked_offset(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new FSError("EINVAL", "offset exceeds JavaScript's integer range");
  }
  return result;
}

// The guest uses asm-generic Linux open flags. Translate them rather than
// relying on their values happening to match the host's node:fs constants.
const linux_open = {
  access: 0x3,
  readonly: 0,
  writeonly: 0x1,
  readwrite: 0x2,
  create: 0x40,
  exclusive: 0x80,
  noTerminal: 0x100,
  truncate: 0x200,
  append: 0x400,
  nonblocking: 0x800,
  dataSync: 0x1000,
  direct: 0x4000,
  largeFile: 0x8000,
  directory: 0x10000,
  noFollow: 0x20000,
  noAtime: 0x40000,
  closeOnExec: 0x80000,
  sync: 0x100000,
  path: 0x200000,
  temporaryFile: 0x400000,
} as const;

const host_constants = constants as unknown as Record<string, number | undefined>;

function translate_open_flags(flags: number) {
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffff_ffff) {
    throw new FSError("EINVAL", "invalid Linux open flags");
  }

  let remaining = flags;
  const access = remaining & linux_open.access;
  remaining &= ~linux_open.access;
  let result: number;
  if (access === linux_open.readonly) result = constants.O_RDONLY;
  else if (access === linux_open.writeonly) result = constants.O_WRONLY;
  else if (access === linux_open.readwrite) result = constants.O_RDWR;
  else throw new FSError("EINVAL", "invalid Linux open access mode");

  const map = (linux: number, host: number | undefined, name: string) => {
    if (!(remaining & linux)) return;
    remaining &= ~linux;
    if (host === undefined) {
      throw new FSError("EOPNOTSUPP", `${name} is not supported by this host`);
    }
    result |= host;
  };

  map(linux_open.create, constants.O_CREAT, "O_CREAT");
  map(linux_open.exclusive, constants.O_EXCL, "O_EXCL");
  map(linux_open.noTerminal, constants.O_NOCTTY, "O_NOCTTY");
  map(linux_open.truncate, constants.O_TRUNC, "O_TRUNC");
  map(linux_open.append, constants.O_APPEND, "O_APPEND");
  map(linux_open.nonblocking, constants.O_NONBLOCK, "O_NONBLOCK");
  if (remaining & linux_open.sync) {
    remaining &= ~(linux_open.sync | linux_open.dataSync);
    result |= constants.O_SYNC;
  } else {
    map(linux_open.dataSync, host_constants.O_DSYNC, "O_DSYNC");
  }
  map(linux_open.direct, host_constants.O_DIRECT, "O_DIRECT");
  map(linux_open.directory, constants.O_DIRECTORY, "O_DIRECTORY");
  map(linux_open.noFollow, constants.O_NOFOLLOW, "O_NOFOLLOW");
  map(linux_open.noAtime, host_constants.O_NOATIME, "O_NOATIME");

  // File descriptors never cross the JavaScript boundary, and Node already
  // opens its own descriptors close-on-exec. O_LARGEFILE is similarly a guest
  // ABI implementation detail rather than a host open mode.
  remaining &= ~(linux_open.largeFile | linux_open.closeOnExec);

  if (remaining & (linux_open.path | linux_open.temporaryFile)) {
    throw new FSError("EOPNOTSUPP", "unsupported Linux open mode");
  }
  if (remaining !== 0) {
    throw new FSError("EINVAL", `unsupported Linux open flags 0x${remaining.toString(16)}`);
  }
  return result;
}

function may_write(flags: number) {
  const access = flags & linux_open.access;
  return (
    access === linux_open.writeonly ||
    access === linux_open.readwrite ||
    (flags &
      (linux_open.create | linux_open.truncate | linux_open.append | linux_open.temporaryFile)) !==
      0
  );
}

class Node {
  parts: string[];
  attached = true;

  constructor(parts: string[]) {
    this.parts = parts;
  }
}

class Handle {
  readonly file: FileHandle | undefined;

  constructor(file?: FileHandle) {
    this.file = file;
  }
}

export interface FSOptions {
  /** Reject all operations which could modify the shared directory. */
  readOnly?: boolean;
}

/**
 * A virtio-fs backend rooted at a host `node:fs` directory.
 *
 * Symbolic links are returned without following their final targets; the guest
 * kernel resolves them inside the guest namespace. Path and symlink escapes are
 * rejected when the host directory is stable.
 *
 * Use an application-owned directory. This is not a sandbox against another
 * host process concurrently restructuring the shared tree: standard Node APIs
 * cannot resolve every operation beneath a trusted directory descriptor.
 */
export class FS implements FileSystemBackend<Node, Handle> {
  readonly root: Node;
  readonly readOnly: boolean;
  readonly #root_path: Promise<string>;
  readonly #nodes = new Map<string, Node>();
  #path_tail = Promise.resolve();

  constructor(root: string, options: FSOptions = {}) {
    this.root = new Node([]);
    this.readOnly = options.readOnly ?? false;
    this.#nodes.set("", this.root);
    this.#root_path = node_call(realpath(path.resolve(root)));
  }

  // Keep validation and its later pathname syscall together relative to every
  // other operation through this adapter. Host namespace changes remain the
  // documented limitation above.
  #path_operation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#path_tail.then(operation, operation);
    this.#path_tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #writable() {
    if (this.readOnly) throw new FSError("EROFS", "filesystem is read-only");
  }

  #node(parts: string[]) {
    const key = parts.join("/");
    let node = this.#nodes.get(key);
    if (!node) {
      node = new Node(parts);
      this.#nodes.set(key, node);
    }
    return node;
  }

  #parts(node: Node) {
    if (!(node instanceof Node)) {
      throw new FSError("EINVAL", "node belongs to another filesystem");
    }
    if (!node.attached) {
      throw new FSError("ENOENT", "filesystem node is no longer attached");
    }
    return node.parts;
  }

  async #path(parts: readonly string[]) {
    const root = await this.#root_path;
    const result = path.resolve(root, ...parts);
    const relative = path.relative(root, result);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new FSError("EACCES", "path escapes the shared directory");
    }
    return result;
  }

  async #validated_path(parts: readonly string[]) {
    // This proves containment only for the namespace observed now. The later
    // Node pathname syscall resolves ancestors again, so this cannot be a
    // security boundary against concurrent host mutation. Closing that race
    // requires descriptor-relative/openat2 operations Node does not expose.
    const root = await this.#root_path;
    const result = await this.#path(parts);
    const parent = parts.length === 0 ? result : path.dirname(result);
    const actual_parent = await node_call(realpath(parent));
    const relative = path.relative(root, actual_parent);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new FSError("EACCES", "path escapes through a symbolic link");
    }
    return result;
  }

  async #stats(node: Node) {
    return await node_call(lstat(await this.#validated_path(this.#parts(node)), { bigint: true }));
  }

  #forget(parts: readonly string[]) {
    const key = parts.join("/");
    for (const [candidate, node] of this.#nodes) {
      if (candidate === key || candidate.startsWith(`${key}/`)) {
        this.#nodes.delete(candidate);
        node.attached = false;
      }
    }
  }

  async lookup(parent: Node, name: string) {
    return await this.#path_operation(async () => {
      const parts = [...this.#parts(parent), valid_name(name)];
      const node = this.#node(parts);
      try {
        await this.#stats(node);
        return node;
      } catch (error) {
        if (error instanceof FSError && (error as { readonly errno: number }).errno === 2) {
          this.#forget(parts);
          return undefined;
        }
        throw error;
      }
    });
  }

  async getattr(node: Node, handle?: Handle) {
    if (handle instanceof Handle && handle.file) {
      return attributes(await node_call(handle.file.stat({ bigint: true })));
    }
    return await this.#path_operation(async () => attributes(await this.#stats(node)));
  }

  async readlink(node: Node) {
    return await this.#path_operation(async () =>
      node_call(readlink(await this.#validated_path(this.#parts(node)))),
    );
  }

  async symlink(parent: Node, name: string, target: string, _context: FSCreateContext) {
    this.#writable();
    return await this.#path_operation(async () => {
      const parts = [...this.#parts(parent), valid_name(name)];
      await node_call(symlink(target, await this.#validated_path(parts)));
      return this.#node(parts);
    });
  }

  async #setattr(node: Node, changes: FSSetAttributes, file?: FileHandle) {
    const target = file ? undefined : await this.#validated_path(this.#parts(node));
    const current = async () =>
      file ? await node_call(file.stat({ bigint: true })) : await this.#stats(node);
    try {
      if (changes.mode !== undefined) {
        if (file) await file.chmod(changes.mode & 0o7777);
        else {
          if ((await this.#stats(node)).isSymbolicLink()) {
            throw new FSError("EOPNOTSUPP", "cannot change a symbolic link's mode");
          }
          await chmod(target!, changes.mode & 0o7777);
        }
      }
      if (changes.uid !== undefined || changes.gid !== undefined) {
        const existing = await current();
        const uid = changes.uid ?? Number(existing.uid);
        const gid = changes.gid ?? Number(existing.gid);
        if (file) await file.chown(uid, gid);
        else await lchown(target!, uid, gid);
      }
      if (changes.size !== undefined) {
        const size = checked_offset(changes.size);
        if (file) await file.truncate(size);
        else {
          const temporary = await open(target!, constants.O_WRONLY | constants.O_NOFOLLOW);
          try {
            await temporary.truncate(size);
          } finally {
            await temporary.close();
          }
        }
      }
      if (changes.atime !== undefined || changes.mtime !== undefined) {
        const existing = await current();
        const now = new Date();
        const to_date = (value: FSSetAttributes["atime"], fallback: bigint) => {
          if (value === undefined) return new Date(Number(fallback / 1_000_000n));
          if (value === "now") return now;
          return new Date(Number(value.seconds * 1000n) + (value.nanoseconds ?? 0) / 1_000_000);
        };
        const atime = to_date(changes.atime, existing.atimeNs);
        const mtime = to_date(changes.mtime, existing.mtimeNs);
        if (file) await file.utimes(atime, mtime);
        else await lutimes(target!, atime, mtime);
      }
      return attributes(await current());
    } catch (error) {
      filesystem_error(error);
    }
  }

  async setattr(node: Node, changes: FSSetAttributes, handle?: Handle) {
    this.#writable();
    if (handle instanceof Handle && handle.file) {
      return await this.#setattr(node, changes, handle.file);
    }
    return await this.#path_operation(async () => this.#setattr(node, changes));
  }

  async open(node: Node, flags: number) {
    if (this.readOnly && may_write(flags)) this.#writable();
    const host_flags = translate_open_flags(flags) | constants.O_NOFOLLOW;
    return await this.#path_operation(async () => {
      const target = await this.#validated_path(this.#parts(node));
      return new Handle(await node_call(open(target, host_flags)));
    });
  }

  async create(parent: Node, name: string, flags: number, context: FSCreateContext) {
    this.#writable();
    const host_flags =
      translate_open_flags(flags | linux_open.create) | constants.O_CREAT | constants.O_NOFOLLOW;
    return await this.#path_operation(async () => {
      const parts = [...this.#parts(parent), valid_name(name)];
      const target = await this.#validated_path(parts);
      const file = await node_call(open(target, host_flags, context.mode & 0o7777));
      return { node: this.#node(parts), handle: new Handle(file) };
    });
  }

  async read(_node: Node, handle: Handle, offset: bigint, length: number) {
    if (!(handle instanceof Handle) || !handle.file) {
      throw new FSError("EBADF");
    }
    const buffer = new Uint8Array(length);
    const { bytesRead } = await node_call(
      handle.file.read(buffer, 0, length, checked_offset(offset)),
    );
    return buffer.subarray(0, bytesRead);
  }

  async write(_node: Node, handle: Handle, offset: bigint, data: Uint8Array) {
    this.#writable();
    if (!(handle instanceof Handle) || !handle.file) {
      throw new FSError("EBADF");
    }
    const { bytesWritten } = await node_call(
      handle.file.write(data, 0, data.byteLength, checked_offset(offset)),
    );
    return bytesWritten;
  }

  async flush(_node: Node, handle: Handle) {
    if (!(handle instanceof Handle) || !handle.file) {
      throw new FSError("EBADF");
    }
    await node_call(handle.file.datasync());
  }

  async fsync(_node: Node, handle: Handle, dataOnly: boolean) {
    if (!(handle instanceof Handle) || !handle.file) {
      throw new FSError("EBADF");
    }
    await node_call(dataOnly ? handle.file.datasync() : handle.file.sync());
  }

  async release(_node: Node, handle: Handle) {
    if (!(handle instanceof Handle) || !handle.file) {
      throw new FSError("EBADF");
    }
    await node_call(handle.file.close());
  }

  async opendir(node: Node) {
    return await this.#path_operation(async () => {
      const stats = await this.#stats(node);
      if (!stats.isDirectory()) throw new FSError("ENOTDIR");
      return new Handle();
    });
  }

  async readdir(node: Node, _handle: Handle): Promise<FSDirectoryEntry<Node>[]> {
    return await this.#path_operation(async () => {
      const parts = this.#parts(node);
      const target = await this.#validated_path(parts);
      const result: FSDirectoryEntry<Node>[] = [];
      for (const entry of await node_call(readdir(target, { withFileTypes: true }))) {
        result.push({
          name: entry.name,
          node: this.#node([...parts, entry.name]),
        });
      }
      return result;
    });
  }

  async mkdir(parent: Node, name: string, context: FSCreateContext) {
    this.#writable();
    return await this.#path_operation(async () => {
      const parts = [...this.#parts(parent), valid_name(name)];
      await node_call(
        mkdir(await this.#validated_path(parts), {
          mode: context.mode & 0o7777,
        }),
      );
      return this.#node(parts);
    });
  }

  async unlink(parent: Node, name: string) {
    this.#writable();
    await this.#path_operation(async () => {
      const parts = [...this.#parts(parent), valid_name(name)];
      await this.#stats(this.#node(parts));
      await node_call(unlink(await this.#validated_path(parts)));
      this.#forget(parts);
    });
  }

  async rmdir(parent: Node, name: string) {
    this.#writable();
    await this.#path_operation(async () => {
      const parts = [...this.#parts(parent), valid_name(name)];
      await this.#stats(this.#node(parts));
      await node_call(rmdir(await this.#validated_path(parts)));
      this.#forget(parts);
    });
  }

  async rename(oldParent: Node, oldName: string, newParent: Node, newName: string) {
    this.#writable();
    await this.#path_operation(async () => {
      const old_parts = [...this.#parts(oldParent), valid_name(oldName)];
      const new_parts = [...this.#parts(newParent), valid_name(newName)];
      if (old_parts.join("/") === new_parts.join("/")) return;
      const source = await this.#validated_path(old_parts);
      await this.#stats(this.#node(old_parts));
      const destination = await this.#validated_path(new_parts);
      await node_call(rename(source, destination));

      this.#forget(new_parts);
      for (const [key, node] of [...this.#nodes]) {
        if (key === old_parts.join("/") || key.startsWith(`${old_parts.join("/")}/`)) {
          this.#nodes.delete(key);
          node.parts = [...new_parts, ...node.parts.slice(old_parts.length)];
          this.#nodes.set(node.parts.join("/"), node);
        }
      }
    });
  }

  async access(node: Node, mask: number) {
    await this.#path_operation(async () => {
      if ((await this.#stats(node)).isSymbolicLink()) {
        throw new FSError("ELOOP");
      }
      await node_call(access(await this.#validated_path(this.#parts(node)), mask));
    });
  }

  async statfs(_node: Node): Promise<FSStat> {
    const stats = await node_call(statfs(await this.#root_path, { bigint: true }));
    return {
      blocks: stats.blocks,
      blocksFree: stats.bfree,
      blocksAvailable: stats.bavail,
      files: stats.files,
      filesFree: stats.ffree,
      blockSize: Number(stats.bsize),
      fragmentSize: Number(stats.bsize),
      nameLength: 255,
    };
  }
}
