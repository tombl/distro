import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { VirtioFileSystemError } from "@tombl/linux";
import { VirtioFileSystem } from "../src/node.ts";

const temporary = await mkdtemp(path.join(tmpdir(), "linux-guest-virtio-fs-"));
const shared = path.join(temporary, "shared");
const outside = path.join(temporary, "outside");
await mkdir(shared);
await mkdir(outside);
after(() => rm(temporary, { recursive: true, force: true }));

test("node virtio-fs adapter reads and writes beneath its root", async () => {
  const filesystem = new VirtioFileSystem(shared);
  const created = await filesystem.create!(
    filesystem.root,
    "hello",
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
    { mode: 0o100640, uid: process.getuid!(), gid: process.getgid!() },
  );
  assert.equal(
    await filesystem.write!(created.node, created.handle, 0n, new TextEncoder().encode("hello")),
    5,
  );
  assert.equal(
    new TextDecoder().decode(await filesystem.read!(created.node, created.handle, 0n, 5)),
    "hello",
  );
  await filesystem.release!(created.node, created.handle);
  assert.equal(await readFile(path.join(shared, "hello"), "utf8"), "hello");
  assert.equal((await filesystem.getattr(created.node)).mode & 0o777, 0o640);
});

test("node virtio-fs adapter rejects adversarial path components", async () => {
  const filesystem = new VirtioFileSystem(shared);
  for (const name of ["", ".", "..", "../outside", "/absolute", "nul\0byte"]) {
    await assert.rejects(
      async () => filesystem.lookup(filesystem.root, name),
      (error) => error instanceof VirtioFileSystemError && [13, 22].includes(error.errno),
      name,
    );
  }
});

test("node virtio-fs adapter exposes a final symlink without following it", async () => {
  await writeFile(path.join(outside, "secret"), "outside");
  await symlink(path.join(outside, "secret"), path.join(shared, "escape"));
  const filesystem = new VirtioFileSystem(shared);
  const escaped = await filesystem.lookup(filesystem.root, "escape");
  assert(escaped);
  assert.equal((await filesystem.getattr(escaped)).mode & constants.S_IFMT, constants.S_IFLNK);
  assert.equal(await filesystem.readlink!(escaped), path.join(outside, "secret"));
});

test("node virtio-fs adapter creates symbolic links", async () => {
  const filesystem = new VirtioFileSystem(shared);
  const linked = await filesystem.symlink!(filesystem.root, "hello-link", "hello", {
    mode: constants.S_IFLNK | 0o777,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  assert.equal(await filesystem.readlink!(linked), "hello");
});

test("node virtio-fs adapter detects an ancestor replaced by a symlink", async () => {
  await mkdir(path.join(shared, "safe"));
  const filesystem = new VirtioFileSystem(shared);
  const safe = await filesystem.lookup(filesystem.root, "safe");
  assert(safe);

  await rename(path.join(shared, "safe"), path.join(shared, "moved"));
  await symlink(outside, path.join(shared, "safe"));
  await assert.rejects(
    async () => filesystem.lookup(safe, "secret"),
    (error) => error instanceof VirtioFileSystemError && error.errno === 13,
  );
});
