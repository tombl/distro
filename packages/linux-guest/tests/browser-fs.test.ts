import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserFS } from "../src/browser.ts";

const not_found = () => new DOMException("entry not found", "NotFoundError");

// A held call computes its answer immediately and delivers it once released,
// like a browser whose File System task finished but whose promise has not yet
// been resolved on the calling thread.
let held: { method: string; name: string; gate: Promise<void> } | undefined;

function hold(method: "getDirectoryHandle" | "getFileHandle" | "createWritable", name: string) {
  const gate = Promise.withResolvers<void>();
  held = { method, name, gate: gate.promise };
  return gate.resolve;
}

async function deliver<T>(method: string, name: string, answer: () => T): Promise<T> {
  let result: { value: T } | { error: unknown };
  try {
    result = { value: answer() };
  } catch (error) {
    result = { error };
  }
  if (held?.method === method && held.name === name) {
    const { gate } = held;
    held = undefined;
    await gate;
  }
  if ("error" in result) throw result.error;
  return result.value;
}

// A minimal origin private file system whose handles identify entries rather
// than paths, so a removed directory's handle stays dead as in Firefox/WebKit.
class FakeDirectory {
  readonly kind = "directory";
  readonly children = new Map<string, FakeDirectory | FakeFile>();
  removed = false;

  #entry(name: string, kind: "directory" | "file", create?: boolean) {
    if (this.removed) throw not_found();
    let entry = this.children.get(name);
    if (!entry && create) {
      entry = kind === "directory" ? new FakeDirectory() : new FakeFile(name);
      this.children.set(name, entry);
    }
    if (!entry) throw not_found();
    if (entry.kind !== kind) throw new DOMException("wrong kind", "TypeMismatchError");
    return entry;
  }

  getDirectoryHandle(name: string, options?: { create?: boolean }) {
    return deliver("getDirectoryHandle", name, () =>
      this.#entry(name, "directory", options?.create),
    );
  }

  getFileHandle(name: string, options?: { create?: boolean }) {
    return deliver("getFileHandle", name, () => this.#entry(name, "file", options?.create));
  }

  async *entries(): AsyncGenerator<[string, FakeDirectory | FakeFile]> {
    yield* this.children;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }) {
    const entry = this.children.get(name);
    if (!entry) throw not_found();
    if (entry.kind === "directory" && entry.children.size && !options?.recursive) {
      throw new DOMException("directory not empty", "InvalidModificationError");
    }
    entry.remove();
    this.children.delete(name);
  }

  remove() {
    this.removed = true;
    for (const child of this.children.values()) child.remove();
  }
}

class FakeFile {
  readonly kind = "file";
  readonly name: string;
  data = new Uint8Array();
  removed = false;

  constructor(name: string) {
    this.name = name;
  }

  remove() {
    this.removed = true;
  }

  async getFile() {
    if (this.removed) throw not_found();
    return new Blob([this.data]);
  }

  createWritable(options?: { keepExistingData?: boolean }) {
    return deliver("createWritable", this.name, () => {
      if (this.removed) throw not_found();
      return new FakeWritable(this, options?.keepExistingData ? this.data : new Uint8Array());
    });
  }
}

// Like FileSystemWritableFileStream, edits a private copy of the file that
// replaces its contents when the stream closes.
class FakeWritable extends WritableStream<Uint8Array> {
  #buffer: Uint8Array<ArrayBuffer>;
  #position = 0;

  constructor(file: FakeFile, initial: Uint8Array) {
    super({
      write: (chunk) => this.#put(chunk),
      close: () => {
        if (file.removed) throw not_found();
        file.data = this.#buffer;
      },
    });
    this.#buffer = initial.slice();
  }

  #put(chunk: Uint8Array) {
    const end = this.#position + chunk.byteLength;
    if (end > this.#buffer.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(this.#buffer);
      this.#buffer = grown;
    }
    this.#buffer.set(chunk, this.#position);
    this.#position = end;
  }

  async seek(position: number) {
    this.#position = position;
  }

  async truncate(size: number) {
    const resized = new Uint8Array(size);
    resized.set(this.#buffer.subarray(0, size));
    this.#buffer = resized;
  }

  async write(data: ArrayBuffer) {
    this.#put(new Uint8Array(data));
  }
}

const context = { mode: 0o755, uid: 0, gid: 0 };

function browser_fs() {
  return new BrowserFS(new FakeDirectory() as unknown as FileSystemDirectoryHandle);
}

test("a stale negative lookup does not detach a recreated directory's child", async () => {
  const fs = browser_fs();
  const old_directory = await fs.mkdir(fs.root, "d", context);

  // Look up d/y in the old d while y does not exist...
  const release = hold("getDirectoryHandle", "y");
  const lookup = fs.lookup(old_directory, "y");
  // ...while another caller replaces d and creates d/y in the new d.
  const replaced = (async () => {
    await fs.rmdir(fs.root, "d");
    const new_directory = await fs.mkdir(fs.root, "d", context);
    return await fs.create(new_directory, "y", 0, context);
  })();
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();

  assert.equal(await lookup, undefined);
  const { node, handle } = await replaced;
  assert.equal((await fs.read(node, handle, 0n, 1)).byteLength, 0);
});

test("a stale negative lookup does not detach a concurrently created sibling", async () => {
  const fs = browser_fs();
  const directory = await fs.mkdir(fs.root, "d", context);

  // The lookup observes that d/y is absent, but its answer arrives only after
  // another caller has created d/y in the same, still attached, directory.
  const release = hold("getFileHandle", "y");
  const lookup = fs.lookup(directory, "y");
  const created = fs.create(directory, "y", 0, context);
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();

  assert.equal(await lookup, undefined);
  const { node, handle } = await created;
  assert.equal((await fs.read(node, handle, 0n, 1)).byteLength, 0);
});

const text = new TextEncoder();

async function contents(fs: BrowserFS, parent: Parameters<BrowserFS["lookup"]>[0], name: string) {
  const node = await fs.lookup(parent, name);
  assert.ok(node);
  const handle = await fs.open(node, 0);
  return new TextDecoder().decode(await fs.read(node, handle, 0n, 64));
}

test("a write during a file rename reaches the renamed file", async () => {
  const fs = browser_fs();
  const { node, handle } = await fs.create(fs.root, "a", 0, context);
  await fs.write(node, handle, 0n, text.encode("old"));

  // Rename copies a to b. While the copy is open, write through a's handle.
  const release = hold("createWritable", "b");
  const rename = fs.rename(fs.root, "a", fs.root, "b");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const write = fs.write(node, handle, 0n, text.encode("new"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();

  await rename;
  assert.equal(await write, 3);
  assert.equal(new TextDecoder().decode(await fs.read(node, handle, 0n, 64)), "new");
  assert.equal(await contents(fs, fs.root, "b"), "new");
});

test("a write in flight when a rename starts reaches the renamed file", async () => {
  const fs = browser_fs();
  const { node, handle } = await fs.create(fs.root, "a", 0, context);
  await fs.write(node, handle, 0n, text.encode("old"));

  // The write has opened a's writable but not yet written when rename starts.
  const release = hold("createWritable", "a");
  const write = fs.write(node, handle, 0n, text.encode("new"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const rename = fs.rename(fs.root, "a", fs.root, "b");
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();

  assert.equal(await write, 3);
  await rename;
  assert.equal(await contents(fs, fs.root, "b"), "new");
});

test("a write during a directory rename reaches the renamed descendant", async () => {
  const fs = browser_fs();
  const directory = await fs.mkdir(fs.root, "d", context);
  const inner = await fs.mkdir(directory, "e", context);
  const { node, handle } = await fs.create(inner, "f", 0, context);
  await fs.write(node, handle, 0n, text.encode("old"));

  // Rename copies d to g, including d/e/f. Write to f while its copy is open.
  const release = hold("createWritable", "f");
  const rename = fs.rename(fs.root, "d", fs.root, "g");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const write = fs.write(node, handle, 0n, text.encode("new"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();

  await rename;
  assert.equal(await write, 3);
  const g = await fs.lookup(fs.root, "g");
  assert.ok(g);
  const e = await fs.lookup(g, "e");
  assert.ok(e);
  assert.equal(await contents(fs, e, "f"), "new");
});
