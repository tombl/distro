// SPDX-License-Identifier: MIT

import {
  type VirtioFileSystem as FileSystemBackend,
  type VirtioFileSystemAttributes,
  type VirtioFileSystemCreateContext,
  type VirtioFileSystemDirectoryEntry,
  VirtioFileSystemError,
  type VirtioFileSystemHandle,
  type VirtioFileSystemNode,
  type VirtioFileSystemSetAttributes,
  type VirtioFileSystemStat,
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
  if (error instanceof VirtioFileSystemError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code && known_errors.has(code)) {
    throw new VirtioFileSystemError(
      code as ConstructorParameters<typeof VirtioFileSystemError>[0],
      (error as Error).message,
    );
  }
  throw new VirtioFileSystemError("EIO", error instanceof Error ? error.message : String(error));
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
    throw new VirtioFileSystemError("EINVAL", "invalid path component");
  }
  return name;
}

function seconds(nanoseconds: bigint) {
  return {
    seconds: nanoseconds / 1_000_000_000n,
    nanoseconds: Number(nanoseconds % 1_000_000_000n),
  };
}

function attributes(stats: BigIntStats): VirtioFileSystemAttributes {
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
    throw new VirtioFileSystemError("EINVAL", "offset exceeds JavaScript's integer range");
  }
  return result;
}

class Node implements VirtioFileSystemNode {
  parts: string[];

  constructor(parts: string[]) {
    this.parts = parts;
  }
}

class Handle implements VirtioFileSystemHandle {
  readonly file: FileHandle | undefined;

  constructor(file?: FileHandle) {
    this.file = file;
  }
}

/**
 * A virtio-fs backend rooted at a host `node:fs` directory.
 *
 * Symbolic links are returned without being followed; the guest kernel resolves
 * their targets inside the guest namespace. A host process with write access
 * can still race an operation by replacing an ancestor between validation and
 * the underlying syscall; fully closing that gap requires an openat2-style
 * native API which Node does not expose.
 */
export class VirtioFileSystem implements FileSystemBackend {
  readonly root: Node;
  readonly #root_path: Promise<string>;
  readonly #nodes = new Map<string, Node>();

  constructor(root: string) {
    this.root = new Node([]);
    this.#nodes.set("", this.root);
    this.#root_path = node_call(realpath(path.resolve(root)));
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

  #parts(node: VirtioFileSystemNode) {
    if (!(node instanceof Node)) {
      throw new VirtioFileSystemError("EINVAL", "node belongs to another filesystem");
    }
    return node.parts;
  }

  async #path(parts: readonly string[]) {
    const root = await this.#root_path;
    const result = path.resolve(root, ...parts);
    const relative = path.relative(root, result);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new VirtioFileSystemError("EACCES", "path escapes the shared directory");
    }
    return result;
  }

  async #validated_path(parts: readonly string[]) {
    const root = await this.#root_path;
    const result = await this.#path(parts);
    const parent = parts.length === 0 ? result : path.dirname(result);
    const actual_parent = await node_call(realpath(parent));
    const relative = path.relative(root, actual_parent);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new VirtioFileSystemError("EACCES", "path escapes through a symbolic link");
    }
    return result;
  }

  async #stats(node: VirtioFileSystemNode) {
    return await node_call(lstat(await this.#validated_path(this.#parts(node)), { bigint: true }));
  }

  #forget(parts: readonly string[]) {
    const key = parts.join("/");
    for (const candidate of this.#nodes.keys()) {
      if (candidate === key || candidate.startsWith(`${key}/`)) this.#nodes.delete(candidate);
    }
  }

  async lookup(parent: VirtioFileSystemNode, name: string) {
    const parts = [...this.#parts(parent), valid_name(name)];
    const node = this.#node(parts);
    try {
      await this.#stats(node);
      return node;
    } catch (error) {
      if (error instanceof VirtioFileSystemError && error.errno === 2) {
        this.#forget(parts);
        return undefined;
      }
      throw error;
    }
  }

  async getattr(node: VirtioFileSystemNode, handle?: VirtioFileSystemHandle) {
    if (handle instanceof Handle && handle.file) {
      return attributes(await node_call(handle.file.stat({ bigint: true })));
    }
    return attributes(await this.#stats(node));
  }

  async readlink(node: VirtioFileSystemNode) {
    return await node_call(readlink(await this.#validated_path(this.#parts(node))));
  }

  async symlink(
    parent: VirtioFileSystemNode,
    name: string,
    target: string,
    _context: VirtioFileSystemCreateContext,
  ) {
    const parts = [...this.#parts(parent), valid_name(name)];
    await node_call(symlink(target, await this.#validated_path(parts)));
    return this.#node(parts);
  }

  async setattr(
    node: VirtioFileSystemNode,
    changes: VirtioFileSystemSetAttributes,
    handle?: VirtioFileSystemHandle,
  ) {
    const target = await this.#validated_path(this.#parts(node));
    const file = handle instanceof Handle ? handle.file : undefined;
    try {
      if (changes.mode !== undefined) {
        if (file) await file.chmod(changes.mode & 0o7777);
        else {
          if ((await this.#stats(node)).isSymbolicLink()) {
            throw new VirtioFileSystemError("EOPNOTSUPP", "cannot change a symbolic link's mode");
          }
          await chmod(target, changes.mode & 0o7777);
        }
      }
      if (changes.uid !== undefined || changes.gid !== undefined) {
        const current = await this.#stats(node);
        const uid = changes.uid ?? Number(current.uid);
        const gid = changes.gid ?? Number(current.gid);
        if (file) await file.chown(uid, gid);
        else await lchown(target, uid, gid);
      }
      if (changes.size !== undefined) {
        const size = checked_offset(changes.size);
        if (file) await file.truncate(size);
        else {
          const temporary = await open(target, constants.O_WRONLY | constants.O_NOFOLLOW);
          try {
            await temporary.truncate(size);
          } finally {
            await temporary.close();
          }
        }
      }
      if (changes.atime !== undefined || changes.mtime !== undefined) {
        const current = await this.#stats(node);
        const now = new Date();
        const to_date = (value: VirtioFileSystemSetAttributes["atime"], fallback: bigint) => {
          if (value === undefined) return new Date(Number(fallback / 1_000_000n));
          if (value === "now") return now;
          return new Date(Number(value.seconds * 1000n) + (value.nanoseconds ?? 0) / 1_000_000);
        };
        const atime = to_date(changes.atime, current.atimeNs);
        const mtime = to_date(changes.mtime, current.mtimeNs);
        if (file) await file.utimes(atime, mtime);
        else await lutimes(target, atime, mtime);
      }
      return await this.getattr(node, handle);
    } catch (error) {
      filesystem_error(error);
    }
  }

  async open(node: VirtioFileSystemNode, flags: number) {
    const target = await this.#validated_path(this.#parts(node));
    return new Handle(await node_call(open(target, flags | constants.O_NOFOLLOW)));
  }

  async create(
    parent: VirtioFileSystemNode,
    name: string,
    flags: number,
    context: VirtioFileSystemCreateContext,
  ) {
    const parts = [...this.#parts(parent), valid_name(name)];
    const target = await this.#validated_path(parts);
    const file = await node_call(
      open(target, flags | constants.O_CREAT | constants.O_NOFOLLOW, context.mode & 0o7777),
    );
    return { node: this.#node(parts), handle: new Handle(file) };
  }

  async read(
    _node: VirtioFileSystemNode,
    handle: VirtioFileSystemHandle,
    offset: bigint,
    length: number,
  ) {
    if (!(handle instanceof Handle) || !handle.file) {
      throw new VirtioFileSystemError("EBADF");
    }
    const buffer = new Uint8Array(length);
    const { bytesRead } = await node_call(
      handle.file.read(buffer, 0, length, checked_offset(offset)),
    );
    return buffer.subarray(0, bytesRead);
  }

  async write(
    _node: VirtioFileSystemNode,
    handle: VirtioFileSystemHandle,
    offset: bigint,
    data: Uint8Array,
  ) {
    if (!(handle instanceof Handle) || !handle.file) {
      throw new VirtioFileSystemError("EBADF");
    }
    const { bytesWritten } = await node_call(
      handle.file.write(data, 0, data.byteLength, checked_offset(offset)),
    );
    return bytesWritten;
  }

  async flush(_node: VirtioFileSystemNode, handle: VirtioFileSystemHandle) {
    if (!(handle instanceof Handle) || !handle.file) {
      throw new VirtioFileSystemError("EBADF");
    }
    await node_call(handle.file.datasync());
  }

  async fsync(_node: VirtioFileSystemNode, handle: VirtioFileSystemHandle, dataOnly: boolean) {
    if (!(handle instanceof Handle) || !handle.file) {
      throw new VirtioFileSystemError("EBADF");
    }
    await node_call(dataOnly ? handle.file.datasync() : handle.file.sync());
  }

  async release(_node: VirtioFileSystemNode, handle: VirtioFileSystemHandle) {
    if (!(handle instanceof Handle) || !handle.file) {
      throw new VirtioFileSystemError("EBADF");
    }
    await node_call(handle.file.close());
  }

  async opendir(node: VirtioFileSystemNode) {
    const stats = await this.#stats(node);
    if (!stats.isDirectory()) throw new VirtioFileSystemError("ENOTDIR");
    return new Handle();
  }

  async readdir(
    node: VirtioFileSystemNode,
    _handle: VirtioFileSystemHandle,
  ): Promise<VirtioFileSystemDirectoryEntry[]> {
    const parts = this.#parts(node);
    const target = await this.#validated_path(parts);
    const result: VirtioFileSystemDirectoryEntry[] = [];
    for (const entry of await node_call(readdir(target, { withFileTypes: true }))) {
      result.push({
        name: entry.name,
        node: this.#node([...parts, entry.name]),
      });
    }
    return result;
  }

  async mkdir(parent: VirtioFileSystemNode, name: string, context: VirtioFileSystemCreateContext) {
    const parts = [...this.#parts(parent), valid_name(name)];
    await node_call(
      mkdir(await this.#validated_path(parts), {
        mode: context.mode & 0o7777,
      }),
    );
    return this.#node(parts);
  }

  async unlink(parent: VirtioFileSystemNode, name: string) {
    const parts = [...this.#parts(parent), valid_name(name)];
    await this.#stats(this.#node(parts));
    await node_call(unlink(await this.#validated_path(parts)));
    this.#forget(parts);
  }

  async rmdir(parent: VirtioFileSystemNode, name: string) {
    const parts = [...this.#parts(parent), valid_name(name)];
    await this.#stats(this.#node(parts));
    await node_call(rmdir(await this.#validated_path(parts)));
    this.#forget(parts);
  }

  async rename(
    oldParent: VirtioFileSystemNode,
    oldName: string,
    newParent: VirtioFileSystemNode,
    newName: string,
  ) {
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
  }

  async access(node: VirtioFileSystemNode, mask: number) {
    if ((await this.#stats(node)).isSymbolicLink()) {
      throw new VirtioFileSystemError("ELOOP");
    }
    await node_call(access(await this.#validated_path(this.#parts(node)), mask));
  }

  async statfs(_node: VirtioFileSystemNode): Promise<VirtioFileSystemStat> {
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
