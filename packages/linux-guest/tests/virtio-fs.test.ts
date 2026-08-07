import assert from "node:assert/strict";
import {
  type FS,
  type FSAttributes,
  type FSCreateContext,
  type FSDirectoryEntry,
  FSError,
  type FSSetAttributes,
  fileSystemDevice,
} from "@tombl/linux";
import { SeekMode } from "../src/index.ts";
import { getdents_inode } from "./assets.ts";
import { guest_test } from "./fixture.ts";
import { pattern_bytes } from "./helpers.ts";

const FileType = {
  directory: 0o040000,
  file: 0o100000,
} as const;

class MemoryNode {
  readonly kind: "directory" | "file";
  mode: number;
  data = new Uint8Array();
  children = new Map<string, MemoryNode>();

  constructor(kind: "directory" | "file", mode: number) {
    this.kind = kind;
    this.mode = FileType[kind] | (mode & 0o7777);
  }
}

class MemoryHandle {
  readonly node: MemoryNode;

  constructor(node: MemoryNode) {
    this.node = node;
  }
}

class MemoryFileSystem implements FS<MemoryNode, MemoryHandle> {
  readonly root = new MemoryNode("directory", 0o755);
  handleGetattrs = 0;
  releases = 0;
  directoryReleases = 0;
  destroys = 0;
  destroyGate: Promise<void> | undefined;
  directoryOpenWaiter: (() => void) | undefined;
  readonly destroyStarted = Promise.withResolvers<void>();

  #node(node: MemoryNode) {
    assert(node instanceof MemoryNode);
    return node;
  }

  #directory(node: MemoryNode) {
    const result = this.#node(node);
    if (result.kind !== "directory") throw new FSError("ENOTDIR");
    return result;
  }

  lookup(parent: MemoryNode, name: string) {
    return this.#directory(parent).children.get(name);
  }

  getattr(node: MemoryNode, handle?: MemoryHandle): FSAttributes {
    if (handle !== undefined) this.handleGetattrs += 1;
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

  setattr(node: MemoryNode, changes: FSSetAttributes) {
    const current = this.#node(node);
    if (changes.mode !== undefined) {
      current.mode = (current.mode & 0o170000) | (changes.mode & 0o7777);
    }
    if (changes.size !== undefined) {
      if (current.kind !== "file") throw new FSError("EISDIR");
      const size = Number(changes.size);
      const data = new Uint8Array(size);
      data.set(current.data.subarray(0, size));
      current.data = data;
    }
    return this.getattr(current);
  }

  open(node: MemoryNode) {
    const current = this.#node(node);
    if (current.kind !== "file") throw new FSError("EISDIR");
    return new MemoryHandle(current);
  }

  create(
    parent: MemoryNode,
    name: string,
    _flags: number,
    context: FSCreateContext,
  ) {
    const directory = this.#directory(parent);
    if (directory.children.has(name)) throw new FSError("EEXIST");
    const node = new MemoryNode("file", context.mode);
    directory.children.set(name, node);
    return { node, handle: new MemoryHandle(node) };
  }

  read(
    node: MemoryNode,
    _handle: MemoryHandle,
    offset: bigint,
    length: number,
  ) {
    const current = this.#node(node);
    return current.data.slice(Number(offset), Number(offset) + length);
  }

  write(
    node: MemoryNode,
    _handle: MemoryHandle,
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

  opendir(node: MemoryNode) {
    this.directoryOpenWaiter?.();
    this.directoryOpenWaiter = undefined;
    return new MemoryHandle(this.#directory(node));
  }

  readdir(node: MemoryNode): FSDirectoryEntry<MemoryNode>[] {
    return [...this.#directory(node).children].map(([name, node]) => ({
      name,
      node,
    }));
  }

  release() {
    this.releases += 1;
  }

  // In-memory store: already durable in the host process, so flush and fsync
  // are declared no-ops.
  flush() {}

  fsync() {}

  releasedir() {
    this.directoryReleases += 1;
  }

  async destroy() {
    this.destroys += 1;
    this.destroyStarted.resolve();
    await this.destroyGate;
  }

  mkdir(parent: MemoryNode, name: string, context: FSCreateContext) {
    const directory = this.#directory(parent);
    if (directory.children.has(name)) throw new FSError("EEXIST");
    const node = new MemoryNode("directory", context.mode);
    directory.children.set(name, node);
    return node;
  }

  unlink(parent: MemoryNode, name: string) {
    const directory = this.#directory(parent);
    const node = directory.children.get(name);
    if (!node) throw new FSError("ENOENT");
    if (node.kind !== "file") throw new FSError("EISDIR");
    directory.children.delete(name);
  }

  rmdir(parent: MemoryNode, name: string) {
    const directory = this.#directory(parent);
    const node = directory.children.get(name);
    if (!node) throw new FSError("ENOENT");
    if (node.kind !== "directory") throw new FSError("ENOTDIR");
    if (node.children.size !== 0) throw new FSError("ENOTEMPTY");
    directory.children.delete(name);
  }

  rename(
    oldParent: MemoryNode,
    oldName: string,
    newParent: MemoryNode,
    newName: string,
  ) {
    const old_directory = this.#directory(oldParent);
    const node = old_directory.children.get(oldName);
    if (!node) throw new FSError("ENOENT");
    old_directory.children.delete(oldName);
    this.#directory(newParent).children.set(newName, node);
  }
}

guest_test("virtio-fs", async (_t, fixture) => {
  const backend = new MemoryFileSystem();
  const guest = await fixture.spawn([
    fileSystemDevice(backend, { tag: "test", cache: false }),
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
  assert.equal((await open.stat()).size, 20);
  assert.equal(backend.handleGetattrs > 0, true);
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

  // More entries than fit in one guest page exercises the no-MMU virtio-fs
  // readdir pagination path rather than only the first FUSE response.
  const pagedDirectory = new MemoryNode("directory", 0o755);
  for (let index = 0; index < 192; index += 1) {
    pagedDirectory.children.set(
      `entry-${index.toString().padStart(3, "0")}`,
      new MemoryNode("file", 0o644),
    );
  }
  backend.root.children.set("paged", pagedDirectory);
  const pagedEntries = [];
  for await (const entry of guest.fs.readDir("/workspace/shared/paged")) {
    pagedEntries.push(entry.name);
  }
  assert.equal(pagedEntries.length, 192);
  assert.equal(new Set(pagedEntries).size, 192);
  backend.root.children.delete("paged");

  await guest.fs.rename(`${directory}/hello`, `${directory}/renamed`);
  assert.deepEqual([...backend.root.children.get("directory")!.children.keys()].sort(), [
    "large",
    "renamed",
  ]);
  await guest.fs.remove(`${directory}/renamed`);
  await guest.fs.remove(`${directory}/large`);
  await guest.fs.remove(directory);
  assert.equal(backend.root.children.size, 0);

  await guest.fs.mkdir("/workspace/shared/source/child", { recursive: true });
  await guest.fs.mkdir("/workspace/shared/destination");
  const movedDirectoryOpened = Promise.withResolvers<void>();
  backend.directoryOpenWaiter = movedDirectoryOpened.resolve;
  const holdingMovedDirectory = await guest.exec([
    "sh",
    "-c",
    "exec 3< /workspace/shared/source/child; sleep 3600",
  ]);
  await movedDirectoryOpened.promise;
  await guest.fs.rename("/workspace/shared/source/child", "/workspace/shared/destination/child");
  await guest.fs.writeFile("/workspace/getdents-inode", getdents_inode);
  await guest.fs.chmod("/workspace/getdents-inode", 0o755);
  const dotdot = await guest.exec([
    "/workspace/getdents-inode",
    "/workspace/shared/destination/child",
    "..",
    "/workspace/shared/destination",
  ]);
  const dotdotStderr = new Response(dotdot.stderr).text();
  const dotdotOutput = new Response(dotdot.stdout).text();
  const dotdotStatus = await dotdot.status;
  assert.equal(dotdotStatus.success, true, await dotdotStderr);
  const [dotdotInode, destinationInode] = (await dotdotOutput).trim().split(" ").map(Number);
  assert.equal(dotdotInode, destinationInode);

  await guest.fs.writeTextFile("/workspace/shared/held", "held open");
  const held = await guest.fs.open("/workspace/shared/held");
  const directoryOpened = Promise.withResolvers<void>();
  backend.directoryOpenWaiter = directoryOpened.resolve;
  const holdingDirectory = await guest.exec(["sh", "-c", "exec 3< /workspace/shared; sleep 3600"]);
  await directoryOpened.promise;
  const releases = backend.releases;
  const directoryReleases = backend.directoryReleases;
  let finishDestroy!: () => void;
  backend.destroyGate = new Promise((resolve) => {
    finishDestroy = resolve;
  });
  guest.machine.close();
  let closed = false;
  void guest.machine.closed.then(() => {
    closed = true;
  });
  try {
    await backend.destroyStarted.promise;
    assert.equal(closed, false);
    assert.equal(backend.releases, releases + 1);
    assert.equal(backend.directoryReleases, directoryReleases + 2);
    assert.equal(backend.destroys, 1);
  } finally {
    finishDestroy();
  }
  await guest.machine.closed;
  guest.machine.close();
  assert.equal(backend.destroys, 1);
  void holdingMovedDirectory;
  void held;
  void holdingDirectory;
});
