// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { open, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { bootMachine } from "../../src/machine/index.ts";
import { guestAgent, type Mount } from "../../src/guest/index.ts";
import { rootImage } from "../../src/image/index.ts";
import { canonical_image, scratch_directory, writable_ext4_copy } from "./assets.ts";

const decoder = new TextDecoder();
const success = { success: true, code: 0, signal: null };

async function boot(root: Mount) {
  const guest = guestAgent({ mounts: [root] });
  const machine = await bootMachine({ cpus: 1, plugins: [guest] });
  return { guest, machine };
}

function erofs_bytes(size = 4096) {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(1024, 0xe0f5e1e2, true);
  return bytes;
}

function ext4_bytes(size = 4096) {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint16(1024 + 56, 0xef53, true);
  return bytes;
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

  await t.test("mounts it beneath a writable overlay", async () => {
    await guest.fs.writeTextFile("/root/marker", "written\n");
    assert.match(await guest.fs.readTextFile("/proc/mounts"), /^overlay \/ overlay rw/m);
  });
});

test("is the root of a mount table, beneath an overlay", () => {
  assert.deepEqual(rootImage(), {
    path: "/",
    source: new URL("../../assets/rootfs.erofs", import.meta.resolve("../../src/image/index.ts")),
    type: "erofs",
    mode: "overlay",
  });
  const blob = new Blob([erofs_bytes()]);
  assert.deepEqual(rootImage(blob), { path: "/", source: blob, mode: "overlay" });
});

test("reads the filesystem of bytes and paths now", async () => {
  assert.equal(rootImage(erofs_bytes()).type, "erofs");
  assert.equal(rootImage(ext4_bytes().buffer).type, "ext4");
  assert.equal(rootImage(canonical_image).type, "erofs");
  assert.equal(rootImage(pathToFileURL(canonical_image)).type, "erofs");
  // Fetched images are read when the machine boots, and the guest tries
  // each filesystem.
  assert.equal(rootImage(new URL("https://example.com/app.ext4")).type, undefined);
  await using handle = await open(canonical_image, "r");
  assert.equal(rootImage(handle).type, undefined);
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
  assert.match(await guest.fs.readTextFile("/proc/mounts"), /^overlay \/ overlay rw/m);
});

test("boots an image from bytes", async () => {
  const { guest, machine } = await boot(rootImage(await readFile(canonical_image)));
  await using _ = machine;
  assert.deepEqual((await guest.run(["true"])).status, success);
});

test("never writes to the image", async () => {
  await using directory = await scratch_directory();
  const path = await writable_ext4_copy(directory.path);
  const before = await readFile(path);
  {
    const { guest, machine } = await boot(rootImage(path));
    await using _ = machine;
    assert.equal(rootImage(path).type, "ext4");
    await guest.fs.writeTextFile("/root/marker", "discarded\n");
    assert.deepEqual((await guest.run(["sync"])).status, success);
  }
  assert.ok(before.equals(await readFile(path)));
});

test("rejects bytes without a superblock", () => {
  assert.throws(
    () => rootImage(new Uint8Array(4096)),
    new Error(
      "the image bytes are not a filesystem image: got 4096 bytes with no EROFS or ext4 superblock",
    ),
  );
});

test("rejects a file that is not a filesystem image", async () => {
  await using directory = await scratch_directory();
  const path = join(directory.path, "index.html");
  const page =
    "<!doctype html><html><head><title>app</title></head><body>not an image</body></html>\n";
  await writeFile(path, page);
  assert.throws(
    () => rootImage(path),
    new Error(`${path} is not a filesystem image: got ${page.length} bytes`),
  );
});

// Linux lists a process's open files in /proc/self/fd.
const open_files = async () => (await readdir("/proc/self/fd")).length;

test("rejects a file that is not whole sectors without leaking it", async () => {
  await using directory = await scratch_directory();
  const path = join(directory.path, "partial.ext4");
  await writeFile(path, ext4_bytes(4097));
  const before = await open_files();
  for (let i = 0; i < 10; i++) {
    assert.throws(
      () => rootImage(path),
      new Error(
        `${path} is not a filesystem image: got 4097 bytes, which is not a multiple of 512`,
      ),
    );
  }
  assert.equal(await open_files(), before);
});

test("rejects a missing file now", () => {
  assert.throws(() => rootImage("/no/such/image.erofs"), { code: "ENOENT" });
});
