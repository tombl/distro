import assert from "node:assert/strict";
import {
  type VirtioFileSystem as VirtioFileSystemBackend,
  type VirtioFileSystemAttributes,
  type VirtioFileSystemCreateContext,
  type VirtioFileSystemDirectoryEntry,
  VirtioFileSystemError,
  type VirtioFileSystemHandle,
  type VirtioFileSystemNode,
  type VirtioFileSystemSetAttributes,
  virtioFileSystemDevice,
} from "@tombl/linux";
import { SeekMode } from "../src/index.ts";
import { guest_test } from "./fixture.ts";
import { pattern_bytes } from "./helpers.ts";

const FileType = {
  directory: 0o040000,
  file: 0o100000,
} as const;

class MemoryNode implements VirtioFileSystemNode {
  readonly kind: "directory" | "file";
  mode: number;
  data = new Uint8Array();
  children = new Map<string, MemoryNode>();

  constructor(kind: "directory" | "file", mode: number) {
    this.kind = kind;
    this.mode = FileType[kind] | (mode & 0o7777);
  }
}

class MemoryHandle implements VirtioFileSystemHandle {
  readonly node: MemoryNode;

  constructor(node: MemoryNode) {
    this.node = node;
  }
}

class MemoryFileSystem implements VirtioFileSystemBackend {
  readonly root = new MemoryNode("directory", 0o755);

  #node(node: VirtioFileSystemNode) {
    assert(node instanceof MemoryNode);
    return node;
  }

  #directory(node: VirtioFileSystemNode) {
    const result = this.#node(node);
    if (result.kind !== "directory") throw new VirtioFileSystemError("ENOTDIR");
    return result;
  }

  lookup(parent: VirtioFileSystemNode, name: string) {
    return this.#directory(parent).children.get(name);
  }

  getattr(node: VirtioFileSystemNode): VirtioFileSystemAttributes {
    const current = this.#node(node);
    return {
      mode: current.mode,
      size: BigInt(current.data.byteLength),
      nlink: current.kind === "directory" ? 2 : 1,
      uid: 0,
      gid: 0,
      blockSize: 4096,
    };
  }

  setattr(node: VirtioFileSystemNode, changes: VirtioFileSystemSetAttributes) {
    const current = this.#node(node);
    if (changes.mode !== undefined) {
      current.mode = (current.mode & 0o170000) | (changes.mode & 0o7777);
    }
    if (changes.size !== undefined) {
      if (current.kind !== "file") throw new VirtioFileSystemError("EISDIR");
      const size = Number(changes.size);
      const data = new Uint8Array(size);
      data.set(current.data.subarray(0, size));
      current.data = data;
    }
    return this.getattr(current);
  }

  open(node: VirtioFileSystemNode) {
    const current = this.#node(node);
    if (current.kind !== "file") throw new VirtioFileSystemError("EISDIR");
    return new MemoryHandle(current);
  }

  create(
    parent: VirtioFileSystemNode,
    name: string,
    _flags: number,
    context: VirtioFileSystemCreateContext,
  ) {
    const directory = this.#directory(parent);
    if (directory.children.has(name)) throw new VirtioFileSystemError("EEXIST");
    const node = new MemoryNode("file", context.mode);
    directory.children.set(name, node);
    return { node, handle: new MemoryHandle(node) };
  }

  read(
    node: VirtioFileSystemNode,
    _handle: VirtioFileSystemHandle,
    offset: bigint,
    length: number,
  ) {
    const current = this.#node(node);
    return current.data.slice(Number(offset), Number(offset) + length);
  }

  write(
    node: VirtioFileSystemNode,
    _handle: VirtioFileSystemHandle,
    offset: bigint,
    data: Uint8Array,
  ) {
    const current = this.#node(node);
    const start = Number(offset);
    if (start + data.byteLength > current.data.byteLength) {
      const grown = new Uint8Array(start + data.byteLength);
      grown.set(current.data);
      current.data = grown;
    }
    current.data.set(data, start);
    return data.byteLength;
  }

  opendir(node: VirtioFileSystemNode) {
    return new MemoryHandle(this.#directory(node));
  }

  readdir(node: VirtioFileSystemNode): VirtioFileSystemDirectoryEntry[] {
    return [...this.#directory(node).children].map(([name, node]) => ({
      name,
      node,
    }));
  }

  mkdir(parent: VirtioFileSystemNode, name: string, context: VirtioFileSystemCreateContext) {
    const directory = this.#directory(parent);
    if (directory.children.has(name)) throw new VirtioFileSystemError("EEXIST");
    const node = new MemoryNode("directory", context.mode);
    directory.children.set(name, node);
    return node;
  }

  unlink(parent: VirtioFileSystemNode, name: string) {
    const directory = this.#directory(parent);
    const node = directory.children.get(name);
    if (!node) throw new VirtioFileSystemError("ENOENT");
    if (node.kind !== "file") throw new VirtioFileSystemError("EISDIR");
    directory.children.delete(name);
  }

  rmdir(parent: VirtioFileSystemNode, name: string) {
    const directory = this.#directory(parent);
    const node = directory.children.get(name);
    if (!node) throw new VirtioFileSystemError("ENOENT");
    if (node.kind !== "directory") throw new VirtioFileSystemError("ENOTDIR");
    if (node.children.size !== 0) throw new VirtioFileSystemError("ENOTEMPTY");
    directory.children.delete(name);
  }

  rename(
    oldParent: VirtioFileSystemNode,
    oldName: string,
    newParent: VirtioFileSystemNode,
    newName: string,
  ) {
    const old_directory = this.#directory(oldParent);
    const node = old_directory.children.get(oldName);
    if (!node) throw new VirtioFileSystemError("ENOENT");
    old_directory.children.delete(oldName);
    this.#directory(newParent).children.set(newName, node);
  }
}

guest_test("virtio-fs", async (_t, fixture) => {
  const backend = new MemoryFileSystem();
  const guest = await fixture.spawn([
    virtioFileSystemDevice(backend, { tag: "test", cache: false }),
  ]);
  const mounted = await guest.exec([
    "sh",
    "-c",
    "mkdir -p /workspace/shared && mount -t virtiofs test /workspace/shared",
  ]);
  const stderr = new Response(mounted.stderr).text();
  const status = await mounted.status;
  assert.equal(status.success, true, await stderr);

  const directory = "/workspace/shared/directory";
  await guest.fs.mkdir(directory);
  await guest.fs.writeTextFile(`${directory}/hello`, "hello from the guest");
  assert.equal(
    new TextDecoder().decode(backend.root.children.get("directory")!.children.get("hello")!.data),
    "hello from the guest",
  );
  assert.equal(await guest.fs.readTextFile(`${directory}/hello`), "hello from the guest");

  const open = await guest.fs.open(`${directory}/hello`);
  const first = new Uint8Array(5);
  assert.equal(await open.read(first), 5);
  assert.equal(new TextDecoder().decode(first), "hello");
  await open.seek(0, SeekMode.Start);
  backend.root.children.get("directory")!.children.get("hello")!.data = new TextEncoder().encode(
    "changed by the host",
  );
  const changed = new Uint8Array(7);
  assert.equal(await open.read(changed), 7);
  assert.equal(new TextDecoder().decode(changed), "changed");
  await open.close();
  backend.root.children.get("directory")!.children.get("hello")!.data = new TextEncoder().encode(
    "hello from the guest",
  );

  await guest.fs.chmod(`${directory}/hello`, 0o600);
  assert.equal((await guest.fs.stat(`${directory}/hello`)).mode & 0o777, 0o600);
  await guest.fs.truncate(`${directory}/hello`, 5);
  assert.equal(await guest.fs.readTextFile(`${directory}/hello`), "hello");

  const large = pattern_bytes(256 * 1024);
  await guest.fs.writeFile(`${directory}/large`, large);
  assert.deepEqual(await guest.fs.readFile(`${directory}/large`), large);

  await guest.fs.rename(`${directory}/hello`, `${directory}/renamed`);
  assert.deepEqual([...backend.root.children.get("directory")!.children.keys()].sort(), [
    "large",
    "renamed",
  ]);
  await guest.fs.remove(`${directory}/renamed`);
  await guest.fs.remove(`${directory}/large`);
  await guest.fs.remove(directory);
  assert.equal(backend.root.children.size, 0);
});
