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
  type VirtioFileSystemTimestamp,
} from "@tombl/linux";

const FileType = {
  directory: 0o040000,
  file: 0o100000,
} as const;

const OpenFlags = {
  EXCLUSIVE: 0x80,
  TRUNCATE: 0x200,
} as const;

interface Metadata {
  mode: number;
  uid: number;
  gid: number;
  atime: VirtioFileSystemTimestamp;
  mtime: VirtioFileSystemTimestamp;
  ctime: VirtioFileSystemTimestamp;
}

function now(): VirtioFileSystemTimestamp {
  const milliseconds = Date.now();
  return {
    seconds: BigInt(Math.floor(milliseconds / 1000)),
    nanoseconds: (milliseconds % 1000) * 1_000_000,
  };
}

function valid_name(name: string) {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    throw new VirtioFileSystemError("EINVAL", "invalid path component");
  }
  return name;
}

function opfs_error(error: unknown): never {
  if (error instanceof VirtioFileSystemError) throw error;
  const name = error instanceof DOMException ? error.name : "";
  const code =
    {
      InvalidModificationError: "ENOTEMPTY",
      NoModificationAllowedError: "EACCES",
      NotAllowedError: "EACCES",
      NotFoundError: "ENOENT",
      QuotaExceededError: "ENOSPC",
      TypeMismatchError: "EINVAL",
    }[name] ?? "EIO";
  throw new VirtioFileSystemError(
    code as ConstructorParameters<typeof VirtioFileSystemError>[0],
    error instanceof Error ? error.message : String(error),
  );
}

async function opfs_call<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    opfs_error(error);
  }
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
  handle: FileSystemHandle;
  metadata: Metadata;
  attached = true;

  constructor(parts: string[], handle: FileSystemHandle, metadata: Metadata) {
    this.parts = parts;
    this.handle = handle;
    this.metadata = metadata;
  }
}

class Handle implements VirtioFileSystemHandle {
  readonly node: Node;

  constructor(node: Node) {
    this.node = node;
  }
}

function default_metadata(kind: FileSystemHandle["kind"]): Metadata {
  const timestamp = now();
  return {
    mode: FileType[kind] | (kind === "directory" ? 0o755 : 0o644),
    uid: 0,
    gid: 0,
    atime: timestamp,
    mtime: timestamp,
    ctime: timestamp,
  };
}

/**
 * A virtio-fs backend for a browser `FileSystemDirectoryHandle`.
 *
 * The browser File System API exposes no Unix ownership, permissions, links,
 * or inode metadata. This adapter presents conventional synthetic values for
 * them and keeps chmod/chown/timestamp changes for the lifetime of this object.
 * File writes use the broadly available asynchronous API.
 */
export class VirtioFileSystem implements FileSystemBackend {
  readonly root: Node;
  readonly #nodes = new Map<string, Node>();

  constructor(root: FileSystemDirectoryHandle) {
    this.root = new Node([], root, default_metadata("directory"));
    this.#nodes.set("", this.root);
  }

  #as_node(node: VirtioFileSystemNode) {
    if (!(node instanceof Node)) {
      throw new VirtioFileSystemError("EINVAL", "node belongs to another filesystem");
    }
    if (!node.attached) {
      throw new VirtioFileSystemError("ENOENT", "filesystem node is no longer attached");
    }
    return node;
  }

  #directory(node: VirtioFileSystemNode) {
    const result = this.#as_node(node);
    if (result.handle.kind !== "directory") {
      throw new VirtioFileSystemError("ENOTDIR");
    }
    return result.handle as FileSystemDirectoryHandle;
  }

  #remember(parts: string[], handle: FileSystemHandle) {
    const key = parts.join("/");
    let node = this.#nodes.get(key);
    if (!node) {
      node = new Node(parts, handle, default_metadata(handle.kind));
      this.#nodes.set(key, node);
    } else {
      node.handle = handle;
    }
    return node;
  }

  #forget(parts: readonly string[]) {
    const key = parts.join("/");
    for (const [candidate, node] of this.#nodes) {
      if (candidate === key || candidate.startsWith(`${key}/`)) {
        node.attached = false;
        this.#nodes.delete(candidate);
      }
    }
  }

  #open_handle(node: VirtioFileSystemNode, handle: VirtioFileSystemHandle) {
    const current = this.#as_node(node);
    if (!(handle instanceof Handle) || handle.node !== current) {
      throw new VirtioFileSystemError("EBADF");
    }
    return current;
  }

  async #child(
    parent: FileSystemDirectoryHandle,
    name: string,
  ): Promise<FileSystemHandle | undefined> {
    try {
      return await parent.getDirectoryHandle(name);
    } catch (error) {
      if (
        !(error instanceof DOMException) ||
        !["NotFoundError", "TypeMismatchError"].includes(error.name)
      ) {
        opfs_error(error);
      }
    }
    try {
      return await parent.getFileHandle(name);
    } catch (error) {
      if (
        error instanceof DOMException &&
        ["NotFoundError", "TypeMismatchError"].includes(error.name)
      ) {
        return undefined;
      }
      opfs_error(error);
    }
  }

  async lookup(parent: VirtioFileSystemNode, name: string) {
    const parent_node = this.#as_node(parent);
    const handle = await this.#child(this.#directory(parent), valid_name(name));
    if (!handle) return undefined;
    return this.#remember([...parent_node.parts, name], handle);
  }

  async getattr(node: VirtioFileSystemNode): Promise<VirtioFileSystemAttributes> {
    const current = this.#as_node(node);
    let size = 0n;
    if (current.handle.kind === "file") {
      const file = await opfs_call((current.handle as FileSystemFileHandle).getFile());
      size = BigInt(file.size);
      current.metadata.mtime = {
        seconds: BigInt(Math.floor(file.lastModified / 1000)),
        nanoseconds: (file.lastModified % 1000) * 1_000_000,
      };
    }
    return {
      mode: current.metadata.mode,
      size,
      nlink: current.handle.kind === "directory" ? 2 : 1,
      uid: current.metadata.uid,
      gid: current.metadata.gid,
      blockSize: 4096,
      atime: current.metadata.atime,
      mtime: current.metadata.mtime,
      ctime: current.metadata.ctime,
    };
  }

  async setattr(node: VirtioFileSystemNode, changes: VirtioFileSystemSetAttributes) {
    const current = this.#as_node(node);
    if (changes.size !== undefined) {
      if (current.handle.kind !== "file") {
        throw new VirtioFileSystemError("EISDIR");
      }
      const writable = await opfs_call(
        (current.handle as FileSystemFileHandle).createWritable({
          keepExistingData: true,
        }),
      );
      try {
        await opfs_call(writable.truncate(checked_offset(changes.size)));
      } finally {
        await opfs_call(writable.close());
      }
    }
    if (changes.mode !== undefined) {
      current.metadata.mode = (current.metadata.mode & 0o170000) | (changes.mode & 0o7777);
    }
    if (changes.uid !== undefined) current.metadata.uid = changes.uid;
    if (changes.gid !== undefined) current.metadata.gid = changes.gid;
    if (changes.atime !== undefined) {
      current.metadata.atime = changes.atime === "now" ? now() : changes.atime;
    }
    if (changes.mtime !== undefined) {
      current.metadata.mtime = changes.mtime === "now" ? now() : changes.mtime;
    }
    if (changes.ctime !== undefined) current.metadata.ctime = changes.ctime;
    else current.metadata.ctime = now();
    return await this.getattr(current);
  }

  async open(node: VirtioFileSystemNode, flags: number) {
    const current = this.#as_node(node);
    if (current.handle.kind !== "file") {
      throw new VirtioFileSystemError("EISDIR");
    }
    if (flags & OpenFlags.TRUNCATE) {
      await this.setattr(current, { size: 0n });
    }
    return new Handle(current);
  }

  async create(
    parent: VirtioFileSystemNode,
    name: string,
    flags: number,
    context: VirtioFileSystemCreateContext,
  ) {
    name = valid_name(name);
    const parent_node = this.#as_node(parent);
    const directory = this.#directory(parent);
    const existing = await this.#child(directory, name);
    if (existing) {
      if (flags & OpenFlags.EXCLUSIVE) {
        throw new VirtioFileSystemError("EEXIST");
      }
      if (existing.kind !== "file") {
        throw new VirtioFileSystemError("EISDIR");
      }
    }
    const file = existing ?? (await opfs_call(directory.getFileHandle(name, { create: true })));
    const node = this.#remember([...parent_node.parts, name], file);
    if (!existing) {
      node.metadata.mode = FileType.file | (context.mode & 0o7777);
      node.metadata.uid = context.uid;
      node.metadata.gid = context.gid;
    }
    if (flags & OpenFlags.TRUNCATE) await this.setattr(node, { size: 0n });
    return { node, handle: new Handle(node) };
  }

  async read(
    node: VirtioFileSystemNode,
    handle: VirtioFileSystemHandle,
    offset: bigint,
    length: number,
  ) {
    const current = this.#open_handle(node, handle);
    if (current.handle.kind !== "file") {
      throw new VirtioFileSystemError("EISDIR");
    }
    const file = await opfs_call((current.handle as FileSystemFileHandle).getFile());
    current.metadata.atime = now();
    return new Uint8Array(
      await opfs_call(
        file.slice(checked_offset(offset), checked_offset(offset) + length).arrayBuffer(),
      ),
    );
  }

  async write(
    node: VirtioFileSystemNode,
    handle: VirtioFileSystemHandle,
    offset: bigint,
    data: Uint8Array,
  ) {
    const current = this.#open_handle(node, handle);
    if (current.handle.kind !== "file") {
      throw new VirtioFileSystemError("EISDIR");
    }
    const writable = await opfs_call(
      (current.handle as FileSystemFileHandle).createWritable({
        keepExistingData: true,
      }),
    );
    try {
      await opfs_call(writable.seek(checked_offset(offset)));
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      await opfs_call(writable.write(copy.buffer));
    } finally {
      await opfs_call(writable.close());
    }
    current.metadata.mtime = now();
    current.metadata.ctime = current.metadata.mtime;
    return data.byteLength;
  }

  async opendir(node: VirtioFileSystemNode) {
    this.#directory(node);
    return new Handle(this.#as_node(node));
  }

  async readdir(
    node: VirtioFileSystemNode,
    handle: VirtioFileSystemHandle,
  ): Promise<VirtioFileSystemDirectoryEntry[]> {
    const current = this.#open_handle(node, handle);
    const result: VirtioFileSystemDirectoryEntry[] = [];
    for await (const [name, handle] of this.#directory(node).entries()) {
      result.push({
        name,
        node: this.#remember([...current.parts, name], handle),
      });
    }
    return result;
  }

  async mkdir(parent: VirtioFileSystemNode, name: string, context: VirtioFileSystemCreateContext) {
    name = valid_name(name);
    const parent_node = this.#as_node(parent);
    if (await this.#child(this.#directory(parent), name)) {
      throw new VirtioFileSystemError("EEXIST");
    }
    const handle = await opfs_call(
      this.#directory(parent).getDirectoryHandle(name, { create: true }),
    );
    const node = this.#remember([...parent_node.parts, name], handle);
    node.metadata.mode = FileType.directory | (context.mode & 0o7777);
    node.metadata.uid = context.uid;
    node.metadata.gid = context.gid;
    return node;
  }

  async unlink(parent: VirtioFileSystemNode, name: string) {
    name = valid_name(name);
    const child = await this.lookup(parent, name);
    if (!child) throw new VirtioFileSystemError("ENOENT");
    if (this.#as_node(child).handle.kind !== "file") {
      throw new VirtioFileSystemError("EISDIR");
    }
    await opfs_call(this.#directory(parent).removeEntry(name));
    this.#forget([...this.#as_node(parent).parts, name]);
  }

  async rmdir(parent: VirtioFileSystemNode, name: string) {
    name = valid_name(name);
    const child = await this.lookup(parent, name);
    if (!child) throw new VirtioFileSystemError("ENOENT");
    if (this.#as_node(child).handle.kind !== "directory") {
      throw new VirtioFileSystemError("ENOTDIR");
    }
    await opfs_call(this.#directory(parent).removeEntry(name));
    this.#forget([...this.#as_node(parent).parts, name]);
  }

  async #copy(source: FileSystemHandle, destination: FileSystemDirectoryHandle, name: string) {
    if (source.kind === "file") {
      const input = await opfs_call((source as FileSystemFileHandle).getFile());
      const output = await opfs_call(destination.getFileHandle(name, { create: true }));
      const writable = await opfs_call(output.createWritable());
      try {
        await opfs_call(writable.write(await input.arrayBuffer()));
      } finally {
        await opfs_call(writable.close());
      }
      return output;
    }
    const output = await opfs_call(destination.getDirectoryHandle(name, { create: true }));
    for await (const [child_name, child] of (source as FileSystemDirectoryHandle).entries()) {
      await this.#copy(child, output, child_name);
    }
    return output;
  }

  async rename(
    oldParent: VirtioFileSystemNode,
    oldName: string,
    newParent: VirtioFileSystemNode,
    newName: string,
  ) {
    oldName = valid_name(oldName);
    newName = valid_name(newName);
    const old_parent = this.#as_node(oldParent);
    const new_parent = this.#as_node(newParent);
    if (old_parent === new_parent && oldName === newName) return;
    const source = await this.lookup(old_parent, oldName);
    if (!source) throw new VirtioFileSystemError("ENOENT");
    const source_node = this.#as_node(source);
    const old_parts = [...old_parent.parts, oldName];
    const new_parts = [...new_parent.parts, newName];
    if (
      source_node.handle.kind === "directory" &&
      new_parts.slice(0, old_parts.length).join("/") === old_parts.join("/")
    ) {
      throw new VirtioFileSystemError("EINVAL", "cannot move a directory into itself");
    }

    const existing = await this.lookup(new_parent, newName);
    if (existing) {
      const existing_node = this.#as_node(existing);
      if (existing_node.handle.kind !== source_node.handle.kind) {
        throw new VirtioFileSystemError(
          source_node.handle.kind === "directory" ? "ENOTDIR" : "EISDIR",
        );
      }
      await opfs_call(this.#directory(new_parent).removeEntry(newName));
      this.#forget(new_parts);
    }

    const copied = await this.#copy(source_node.handle, this.#directory(new_parent), newName);
    await opfs_call(
      this.#directory(old_parent).removeEntry(oldName, {
        recursive: source_node.handle.kind === "directory",
      }),
    );

    const moved = [...this.#nodes].filter(
      ([key]) => key === old_parts.join("/") || key.startsWith(`${old_parts.join("/")}/`),
    );
    moved.sort(([, left], [, right]) => left.parts.length - right.parts.length);
    for (const [key, node] of moved) {
      const relative = node.parts.slice(old_parts.length);
      let handle: FileSystemHandle = copied;
      for (const component of relative) {
        if (handle.kind !== "directory") throw new VirtioFileSystemError("EIO");
        const child = await this.#child(handle as FileSystemDirectoryHandle, component);
        if (!child) throw new VirtioFileSystemError("EIO");
        handle = child;
      }
      node.handle = handle;
      if (key === old_parts.join("/") || key.startsWith(`${old_parts.join("/")}/`)) {
        this.#nodes.delete(key);
        node.parts = [...new_parts, ...node.parts.slice(old_parts.length)];
        this.#nodes.set(node.parts.join("/"), node);
      }
    }
  }
}
