// SPDX-License-Identifier: MIT

// The fetch path that browsers use, exercised with a mocked fetch.

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { VirtioDevice } from "@lowland/kernel";
import type { MachinePlugin, MachineSetup } from "@lowland/kernel/plugin";
import { rootImage } from "../src/index.ts";

function erofs_image(size = 4096) {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(1024, 0xe0f5e1e2, true);
  return bytes;
}

function ext4_image(size = 4096) {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint16(1024 + 56, 0xef53, true);
  return bytes;
}

async function configure(plugin: MachinePlugin) {
  const devices: VirtioDevice[] = [];
  const setup: MachineSetup = {
    args: { add() {} },
    devices: { add: (...added) => devices.push(...added) },
    deviceTree: { merge() {} },
  };
  await plugin.configure(setup);
  return devices;
}

function mock_fetch(t: TestContext, respond: () => Response) {
  return t.mock.method(globalThis, "fetch", async () => respond());
}

test("fetches a URL once for every machine", async (t) => {
  const fetch = mock_fetch(
    t,
    () => new Response(erofs_image(), { headers: { "content-type": "application/octet-stream" } }),
  );
  const image = rootImage(new URL("https://example.com/once.erofs"));
  assert.equal((await configure(image)).length, 1);
  assert.equal((await configure(image)).length, 1);
  assert.equal(fetch.mock.callCount(), 1);
});

test("accepts an ext4 image", async (t) => {
  mock_fetch(t, () => new Response(ext4_image()));
  assert.equal((await configure(rootImage(new URL("https://example.com/app.ext4")))).length, 1);
});

test("rejects an HTML fallback page", async (t) => {
  const page = "x".repeat(116);
  mock_fetch(t, () => new Response(page, { headers: { "content-type": "text/html" } }));
  const url = "https://example.com/html.erofs";
  await assert.rejects(
    () => configure(rootImage(new URL(url))),
    new Error(`${url} did not return a filesystem image: got text/html, 116 bytes`),
  );
});

test("rejects HTML even when it is large", async (t) => {
  mock_fetch(
    t,
    () => new Response(erofs_image(), { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  await assert.rejects(
    () => configure(rootImage(new URL("https://example.com/large.erofs"))),
    /did not return a filesystem image: got text\/html, 4096 bytes$/,
  );
});

test("rejects an image without a superblock", async (t) => {
  mock_fetch(t, () => new Response(new Uint8Array(4096)));
  await assert.rejects(
    () => configure(rootImage(new URL("https://example.com/zero.erofs"))),
    /did not return a filesystem image: got 4096 bytes with no EROFS or ext4 superblock$/,
  );
});

test("retries a failed fetch", async (t) => {
  let status = 404;
  mock_fetch(t, () => new Response(erofs_image(), { status }));
  const image = rootImage(new URL("https://example.com/retry.erofs"));
  await assert.rejects(() => configure(image), /failed to load .*: 404$/);
  status = 200;
  assert.equal((await configure(image)).length, 1);
});

test("accepts blobs and responses", async () => {
  assert.equal((await configure(rootImage(new Blob([erofs_image()])))).length, 1);
  const response = rootImage(new Response(erofs_image()));
  assert.equal((await configure(response)).length, 1);
  assert.equal((await configure(response)).length, 1);
});

test("rejects bytes without a superblock", async () => {
  await assert.rejects(
    () => configure(rootImage(new Uint8Array(100))),
    new Error("the image bytes are not a filesystem image: got 100 bytes"),
  );
});

test("rejects a writable blob or canonical image", () => {
  assert.throws(() => rootImage(new Blob([erofs_image()]), { writable: true }), /writable/);
  assert.throws(() => rootImage(undefined, { writable: true }), /canonical image/);
});

function file_handle(bytes: Uint8Array) {
  return {
    async read(buffer: Uint8Array, offset: number, length: number, position: number) {
      const source = bytes.subarray(position, position + length);
      buffer.set(source, offset);
      return { bytesRead: source.byteLength };
    },
    async write(buffer: Uint8Array, offset: number, length: number, position: number) {
      bytes.set(buffer.subarray(offset, offset + length), position);
      return { bytesWritten: length };
    },
    async stat() {
      return { size: bytes.byteLength };
    },
    async datasync() {},
  };
}

test("rejects writable EROFS bytes immediately", () => {
  assert.throws(
    () => rootImage(erofs_image(), { writable: true }),
    new Error("the image bytes: EROFS images are read-only; writable has no effect"),
  );
});

test("rejects a writable EROFS file handle when it boots", async () => {
  const image = rootImage(file_handle(erofs_image()), { writable: true });
  await assert.rejects(
    () => configure(image),
    new Error("the file handle: EROFS images are read-only; writable has no effect"),
  );
});

test("accepts writable ext4 bytes and file handles", async () => {
  assert.equal((await configure(rootImage(ext4_image(), { writable: true }))).length, 1);
  const handle = file_handle(ext4_image());
  assert.equal((await configure(rootImage(handle, { writable: true }))).length, 1);
});

test("rejects images that are not whole sectors", async () => {
  await assert.rejects(
    () => configure(rootImage(ext4_image(4097))),
    new Error(
      "the image bytes are not a filesystem image: got 4097 bytes, which is not a multiple of 512",
    ),
  );
  await assert.rejects(
    () => configure(rootImage(file_handle(ext4_image(4097)))),
    /^Error: the file handle is not a filesystem image: got 4097 bytes, which is not a multiple of 512$/,
  );
});
