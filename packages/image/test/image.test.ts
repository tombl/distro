// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { bootMachine, type Device } from "@lowland/kernel";
import type { MachinePlugin } from "@lowland/kernel/plugin";
import { guestAgent } from "@lowland/guest";
import { rootImage } from "../src/index.ts";
import { canonical_image, scratch_directory, writable_ext4_copy } from "./assets.ts";

const decoder = new TextDecoder();
const success = { success: true, code: 0, signal: null };

async function boot(image: MachinePlugin) {
  const guest = guestAgent();
  const machine = await bootMachine({ cpus: 1, plugins: [image, guest] });
  return { guest, machine };
}

// blockDevice() advertises VIRTIO_BLK_F_RO when its storage has no write
// callback. The transport that carries the feature bits is private to
// @lowland/kernel, so find it among the device's symbol properties.
const VIRTIO_BLK_F_RO = 1n << 5n;

async function read_only(image: MachinePlugin) {
  const devices: Device[] = [];
  await image.configure({
    args: { add() {} },
    devices: { add: (...added) => devices.push(...added) },
    bootConsole: new ReadableStream(),
  });
  assert.equal(devices.length, 1);
  const device = devices[0] as unknown as Record<symbol, unknown>;
  const transport = Object.getOwnPropertySymbols(device)
    .map((symbol) => device[symbol] as { features?: unknown; shutdown?(): Promise<void> })
    .find((value) => typeof value?.features === "bigint");
  assert.ok(transport);
  // Closing the device releases a file opened from a path.
  await transport.shutdown!();
  return ((transport.features as bigint) & VIRTIO_BLK_F_RO) !== 0n;
}

test("boots the root image with the guest agent", async (t) => {
  const { guest, machine } = await boot(rootImage());
  await using _ = machine;

  await t.test("runs uname", async () => {
    const result = await guest.run(["uname", "-a"]);
    assert.deepEqual(result.status, success);
    assert.match(decoder.decode(result.stdout), /^Linux /);
  });

  await t.test("runs apk", async () => {
    const result = await guest.run(["apk", "--version"]);
    assert.deepEqual(result.status, success);
    assert.match(decoder.decode(result.stdout), /^apk-tools 3\./);
  });

  await t.test("configures the public repository", async () => {
    const repositories = await guest.fs.readTextFile("/etc/apk/repositories");
    assert.equal(repositories, "http://assets.low.land/apk/wasm32/Packages.adb\n");
    await guest.fs.stat("/etc/apk/keys/site.rsa.pub");
    await guest.fs.stat("/etc/ssl/cert.pem");
  });
});

test("boots an image from a path", async () => {
  const { guest, machine } = await boot(rootImage(canonical_image));
  await using _ = machine;
  assert.deepEqual((await guest.run(["true"])).status, success);
});

test("boots an image from a file URL", async () => {
  const { guest, machine } = await boot(rootImage(pathToFileURL(canonical_image)));
  await using _ = machine;
  assert.deepEqual((await guest.run(["true"])).status, success);
});

test("boots an image from a file handle", async () => {
  await using handle = await open(canonical_image, "r");
  const { guest, machine } = await boot(rootImage(handle));
  await using _ = machine;
  assert.deepEqual((await guest.run(["true"])).status, success);
});

test("boots an image from bytes", async () => {
  const { guest, machine } = await boot(rootImage(await readFile(canonical_image)));
  await using _ = machine;
  assert.deepEqual((await guest.run(["true"])).status, success);
});

test("keeps writes to a writable ext4 path across reboots", async () => {
  await using directory = await scratch_directory();
  const path = await writable_ext4_copy(directory.path);
  const image = rootImage(path, { writable: true });

  {
    const { guest, machine } = await boot(image);
    await using _ = machine;
    await guest.fs.writeTextFile("/root/marker", "persisted\n");
    assert.deepEqual((await guest.run(["sync"])).status, success);
  }

  const { guest, machine } = await boot(image);
  await using _ = machine;
  assert.equal(await guest.fs.readTextFile("/root/marker"), "persisted\n");
});

test("modifies writable bytes in place", async () => {
  await using directory = await scratch_directory();
  const bytes = await readFile(await writable_ext4_copy(directory.path));
  const before = Buffer.from(bytes);
  {
    const { guest, machine } = await boot(rootImage(bytes, { writable: true }));
    await using _ = machine;
    await guest.fs.writeTextFile("/root/marker", "persisted\n");
    assert.deepEqual((await guest.run(["sync"])).status, success);
  }
  assert.notDeepEqual(bytes, before);
});

test("attaches read-only images as read-only devices", async () => {
  await using directory = await scratch_directory();
  const path = await writable_ext4_copy(directory.path);
  const bytes = await readFile(path);
  assert.equal(await read_only(rootImage(path)), true);
  assert.equal(await read_only(rootImage(bytes)), true);
  assert.equal(await read_only(rootImage(path, { writable: true })), false);
  assert.equal(await read_only(rootImage(bytes, { writable: true })), false);
});

test("rejects a writable URL", () => {
  assert.throws(
    () => rootImage(new URL("https://example.com/app.ext4"), { writable: true }),
    /writable image needs a file path, file handle, or bytes/,
  );
});

test("rejects a writable EROFS path when it boots", async () => {
  await using directory = await scratch_directory();
  const path = join(directory.path, "root.erofs");
  await writeFile(path, await readFile(canonical_image));
  const before = await readFile(path);
  await assert.rejects(
    () => boot(rootImage(path, { writable: true })),
    new Error(`${path}: EROFS images are read-only; writable has no effect`),
  );
  assert.ok(before.equals(await readFile(path)));
});

test("rejects a file that is not a filesystem image", async () => {
  await using directory = await scratch_directory();
  const path = join(directory.path, "index.html");
  const page =
    "<!doctype html><html><head><title>app</title></head><body>not an image</body></html>\n";
  await writeFile(path, page);
  await assert.rejects(
    () => boot(rootImage(path)),
    new Error(`${path} is not a filesystem image: got ${page.length} bytes`),
  );
});
