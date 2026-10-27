import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserFS } from "../src/browser.ts";

const not_found = () => new DOMException("entry not found", "NotFoundError");

// A held call computes its answer immediately and delivers it once released,
// like a browser whose File System task finished but whose promise has not yet
// been resolved on the calling thread.
let held: { method: string; name: string; gate: Promise<void> } | undefined;

function hold(method: "getDirectoryHandle" | "getFileHandle", name: string) {
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
  readonly entries = new Map<string, FakeDirectory | FakeFile>();
  removed = false;

  #entry(name: string, kind: "directory" | "file", create?: boolean) {
    if (this.removed) throw not_found();
    let entry = this.entries.get(name);
    if (!entry && create) {
      entry = kind === "directory" ? new FakeDirectory() : new FakeFile();
      this.entries.set(name, entry);
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

  async removeEntry(name: string) {
    const entry = this.entries.get(name);
    if (!entry) throw not_found();
    if (entry.kind === "directory" && entry.entries.size) {
      throw new DOMException("directory not empty", "InvalidModificationError");
    }
    entry.removed = true;
    this.entries.delete(name);
  }
}

class FakeFile {
  readonly kind = "file";
  removed = false;

  async getFile() {
    if (this.removed) throw not_found();
    return new Blob([]);
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
