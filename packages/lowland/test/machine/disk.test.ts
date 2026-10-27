// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { diskStorage, type BlockStorage, type DiskFileHandle } from "../../src/machine/index.ts";

function disk(size = 4096) {
  const bytes = new Uint8Array(size);
  bytes.fill(7, 1024, 1032);
  return bytes;
}

async function read(storage: BlockStorage, offset: number, length: number) {
  const target = new Uint8Array(length);
  assert.equal(await storage.read(offset, target), length);
  return target;
}

function mock_fetch(t: TestContext, respond: () => Response) {
  return t.mock.method(globalThis, "fetch", async () => respond());
}

function file_handle(bytes: Uint8Array): DiskFileHandle {
  return {
    async read(buffer, offset, length, position) {
      const source = bytes.subarray(position, position + length);
      buffer.set(source, offset);
      return { bytesRead: source.byteLength };
    },
    async write(buffer, offset, length, position) {
      bytes.set(buffer.subarray(offset, offset + length), position);
      return { bytesWritten: length };
    },
    async stat() {
      return { size: bytes.byteLength };
    },
    async datasync() {},
  };
}

async function scratch(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "lowland-disk-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("serves bytes, and writes them in place only when writable", async () => {
  const bytes = disk();
  const read_only = await diskStorage(bytes, { writable: false });
  assert.equal(read_only.capacity, 4096);
  assert.equal(read_only.write, undefined);
  assert.deepEqual(await read(read_only, 1024, 8), new Uint8Array(8).fill(7));

  const writable = await diskStorage(bytes.buffer, { writable: true });
  assert.equal(await writable.write!(0, new Uint8Array([1, 2])), 2);
  assert.deepEqual(bytes.subarray(0, 2), new Uint8Array([1, 2]));
});

test("fetches a URL once for every machine", async (t) => {
  const fetch = mock_fetch(
    t,
    () => new Response(disk(), { headers: { "content-type": "application/octet-stream" } }),
  );
  const url = new URL("https://example.com/once.img");
  assert.equal((await diskStorage(url, { writable: false })).capacity, 4096);
  assert.equal((await diskStorage(url, { writable: false })).capacity, 4096);
  assert.equal(fetch.mock.callCount(), 1);
});

test("retries a failed fetch", async (t) => {
  let status = 404;
  mock_fetch(t, () => new Response(disk(), { status }));
  const url = new URL("https://example.com/retry.img");
  await assert.rejects(diskStorage(url, { writable: false }), /failed to load .*: 404$/);
  status = 200;
  assert.equal((await diskStorage(url, { writable: false })).capacity, 4096);
});

test("rejects an HTML fallback page", async (t) => {
  const page = "x".repeat(116);
  mock_fetch(t, () => new Response(page, { headers: { "content-type": "text/html" } }));
  const url = "https://example.com/html.img";
  await assert.rejects(
    diskStorage(new URL(url), { writable: false }),
    new Error(`${url} did not return a disk image: got text/html, 116 bytes`),
  );
});

test("rejects HTML even when it is whole sectors", async (t) => {
  mock_fetch(
    t,
    () => new Response(disk(), { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  await assert.rejects(
    diskStorage(new URL("https://example.com/large.img"), { writable: false }),
    /did not return a disk image: got text\/html, 4096 bytes$/,
  );
});

test("accepts blobs and responses, reading each once", async () => {
  assert.equal((await diskStorage(new Blob([disk()]), { writable: false })).capacity, 4096);
  const response = new Response(disk());
  assert.equal((await diskStorage(response, { writable: false })).capacity, 4096);
  assert.equal((await diskStorage(response, { writable: false })).capacity, 4096);
  await assert.rejects(
    diskStorage(new Blob(["<html>"], { type: "text/html" }), { writable: false }),
    /^Error: the blob is not a disk image: got text\/html, 6 bytes$/,
  );
});

test("rejects disks that are not whole sectors", async () => {
  await assert.rejects(
    diskStorage(disk(4097), { writable: false }),
    new Error("the bytes are not a disk image: got 4097 bytes, which is not a multiple of 512"),
  );
  await assert.rejects(
    diskStorage(file_handle(disk(4097)), { writable: false }),
    /^Error: the file handle is not a disk image: got 4097 bytes, which is not a multiple of 512$/,
  );
});

test("rejects writable sources that cannot be written", async () => {
  await assert.rejects(
    diskStorage(new URL("https://example.com/app.img"), { writable: true }),
    TypeError,
  );
  await assert.rejects(diskStorage(new Blob([disk()]), { writable: true }), TypeError);
  await assert.rejects(
    diskStorage({ capacity: 512, read: () => 0 }, { writable: true }),
    /must implement write/,
  );
});

test("opens block storage read-only unless writable", async () => {
  let writes = 0;
  let closes = 0;
  const storage: BlockStorage = {
    capacity: 512,
    read: (_offset, target) => target.byteLength,
    write: (_offset, data) => (writes++, data.byteLength),
    flush() {},
    close: () => void closes++,
  };
  const read_only = await diskStorage(storage, { writable: false });
  assert.equal(read_only.write, undefined);
  assert.equal(read_only.flush, undefined);
  await read_only.close?.();
  assert.equal(closes, 1);
  assert.equal(await diskStorage(storage, { writable: true }), storage);
  assert.equal(writes, 0);
});

test("writes through a file handle only when writable", async () => {
  const bytes = disk();
  const read_only = await diskStorage(file_handle(bytes), { writable: false });
  assert.equal(read_only.write, undefined);
  const writable = await diskStorage(file_handle(bytes), { writable: true });
  assert.equal(await writable.write!(512, new Uint8Array([9])), 1);
  assert.equal(bytes[512], 9);
});

// Linux lists a process's open files in /proc/self/fd.
const open_files = async () => (await readdir("/proc/self/fd")).length;

test("opens a path, and closes it with the storage", async (t) => {
  const path = join(await scratch(t), "disk.img");
  await writeFile(path, disk());
  const before = await open_files();
  const storage = await diskStorage(path, { writable: true });
  assert.equal(await storage.write!(0, new Uint8Array([5])), 1);
  await storage.flush!();
  await storage.close!();
  assert.equal(await open_files(), before);
  assert.equal((await readFile(path))[0], 5);
});

test("rejects a path that is not whole sectors without leaking it", async (t) => {
  const path = join(await scratch(t), "partial.img");
  await writeFile(path, disk(4097));
  const before = await open_files();
  for (let i = 0; i < 10; i++) {
    await assert.rejects(
      diskStorage(path, { writable: false }),
      new Error(`${path} is not a disk image: got 4097 bytes, which is not a multiple of 512`),
    );
  }
  assert.equal(await open_files(), before);
});
