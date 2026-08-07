import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { FSError } from "@tombl/linux";
import { FS } from "../src/node.ts";

// Virtio-fs carries Linux ABI flags even when this test runs on another host.
const linux_open = {
  readonly: 0,
  writeonly: 1,
  readwrite: 2,
  create: 0x40,
  exclusive: 0x80,
  truncate: 0x200,
  closeOnExec: 0x80000,
  path: 0x200000,
} as const;

const temporary = await mkdtemp(path.join(tmpdir(), "linux-guest-virtio-fs-"));
const shared = path.join(temporary, "shared");
const outside = path.join(temporary, "outside");
await mkdir(shared);
await mkdir(outside);
after(() => rm(temporary, { recursive: true, force: true }));

test("node virtio-fs adapter reads and writes beneath its root", async () => {
  const filesystem = new FS(shared);
  const created = await filesystem.create!(
    filesystem.root,
    "hello",
    linux_open.readwrite | linux_open.create | linux_open.exclusive,
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
  const filesystem = new FS(shared);
  for (const name of ["", ".", "..", "../outside", "/absolute", "nul\0byte"]) {
    await assert.rejects(
      async () => filesystem.lookup(filesystem.root, name),
      (error) => error instanceof FSError && [13, 22].includes(error.errno),
      name,
    );
  }
});

test("node virtio-fs adapter exposes a final symlink without following it", async () => {
  await writeFile(path.join(outside, "secret"), "outside");
  await symlink(path.join(outside, "secret"), path.join(shared, "escape"));
  const filesystem = new FS(shared);
  const escaped = await filesystem.lookup(filesystem.root, "escape");
  assert(escaped);
  assert.equal((await filesystem.getattr(escaped)).mode & constants.S_IFMT, constants.S_IFLNK);
  assert.equal(await filesystem.readlink!(escaped), path.join(outside, "secret"));
});

test("node virtio-fs adapter never follows a final symlink for metadata operations", async () => {
  const target = path.join(outside, "metadata-target");
  const link = path.join(shared, "metadata-escape");
  await writeFile(target, "outside", { mode: 0o640 });
  await symlink(target, link);
  const before = await stat(target);
  const filesystem = new FS(shared);
  const escaped = await filesystem.lookup(filesystem.root, "metadata-escape");
  assert(escaped);

  await assert.rejects(
    filesystem.setattr!(escaped, { mode: 0o600 }),
    (error) => error instanceof FSError && error.errno === 95,
  );
  await filesystem.setattr!(escaped, {
    atime: { seconds: 1n },
    mtime: { seconds: 1n },
  });
  await assert.rejects(
    filesystem.access!(escaped, constants.R_OK),
    (error) => error instanceof FSError && error.errno === 40,
  );

  const after = await stat(target);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await lstat(link)).mtimeMs, 1000);
});

test("node virtio-fs adapter keeps open files distinct across unlink and recreate", async () => {
  const filesystem = new FS(shared);
  const old = await filesystem.create!(filesystem.root, "recreated", linux_open.readwrite, {
    mode: constants.S_IFREG | 0o600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  await filesystem.write!(old.node, old.handle, 0n, new TextEncoder().encode("old"));
  await filesystem.unlink!(filesystem.root, "recreated");
  const replacement = await filesystem.create!(filesystem.root, "recreated", linux_open.readwrite, {
    mode: constants.S_IFREG | 0o600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  await filesystem.write!(
    replacement.node,
    replacement.handle,
    0n,
    new TextEncoder().encode("new"),
  );

  assert.equal((await filesystem.getattr(old.node, old.handle)).size, 3n);
  assert.equal(
    new TextDecoder().decode(await filesystem.read!(old.node, old.handle, 0n, 3)),
    "old",
  );
  await assert.rejects(
    filesystem.getattr(old.node),
    (error) => error instanceof FSError && error.errno === 2,
  );
  await assert.rejects(
    filesystem.open!(old.node, linux_open.readonly),
    (error) => error instanceof FSError && error.errno === 2,
  );
  await filesystem.setattr!(old.node, { size: 2n }, old.handle);
  assert.equal(new TextDecoder().decode(await filesystem.read!(old.node, old.handle, 0n, 3)), "ol");
  assert.equal(await readFile(path.join(shared, "recreated"), "utf8"), "new");
  await filesystem.release!(old.node, old.handle);
  await filesystem.release!(replacement.node, replacement.handle);
});

test("node virtio-fs adapter preserves inode generations across replacement rename", async () => {
  const filesystem = new FS(shared);
  const source = await filesystem.create!(filesystem.root, "rename-source", linux_open.readwrite, {
    mode: constants.S_IFREG | 0o600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  const destination = await filesystem.create!(
    filesystem.root,
    "rename-destination",
    linux_open.readwrite,
    {
      mode: constants.S_IFREG | 0o600,
      uid: process.getuid!(),
      gid: process.getgid!(),
    },
  );
  await filesystem.write!(source.node, source.handle, 0n, new TextEncoder().encode("source"));
  await filesystem.release!(source.node, source.handle);
  await filesystem.release!(destination.node, destination.handle);

  await filesystem.rename!(filesystem.root, "rename-source", filesystem.root, "rename-destination");

  assert.equal(await filesystem.lookup(filesystem.root, "rename-destination"), source.node);
  assert.equal((await filesystem.getattr(source.node)).size, 6n);
  await assert.rejects(
    filesystem.getattr(destination.node),
    (error) => error instanceof FSError && error.errno === 2,
  );
});

test("node virtio-fs adapter enforces read-only shares in the backend", async () => {
  const name = "read-only-source";
  await writeFile(path.join(shared, name), "readable");
  const filesystem = new FS(shared, { readOnly: true });
  const node = await filesystem.lookup(filesystem.root, name);
  assert(node);
  const handle = await filesystem.open!(node, linux_open.readonly | linux_open.closeOnExec);
  assert.equal(new TextDecoder().decode(await filesystem.read!(node, handle, 0n, 8)), "readable");

  for (const operation of [
    () => filesystem.open!(node, linux_open.writeonly),
    () => filesystem.open!(node, linux_open.readonly | linux_open.truncate),
    () => filesystem.write!(node, handle, 0n, new Uint8Array([1])),
    () => filesystem.setattr!(node, { mode: 0o600 }),
    () =>
      filesystem.create!(filesystem.root, "read-only-created", linux_open.readwrite, {
        mode: constants.S_IFREG | 0o600,
        uid: process.getuid!(),
        gid: process.getgid!(),
      }),
    () =>
      filesystem.mkdir!(filesystem.root, "read-only-directory", {
        mode: constants.S_IFDIR | 0o700,
        uid: process.getuid!(),
        gid: process.getgid!(),
      }),
    () => filesystem.unlink!(filesystem.root, name),
  ]) {
    await assert.rejects(operation, (error) => error instanceof FSError && error.errno === 30);
  }
  await filesystem.release!(node, handle);
  assert.equal(await readFile(path.join(shared, name), "utf8"), "readable");
});

test("node virtio-fs adapter rejects Linux open modes it cannot implement", async () => {
  const filesystem = new FS(shared);
  const node = await filesystem.lookup(filesystem.root, "hello");
  assert(node);
  await assert.rejects(
    filesystem.open!(node, linux_open.readonly | linux_open.path),
    (error) => error instanceof FSError && error.errno === 95,
  );
});

test("node virtio-fs adapter creates symbolic links", async () => {
  const filesystem = new FS(shared);
  const linked = await filesystem.symlink!(filesystem.root, "hello-link", "hello", {
    mode: constants.S_IFLNK | 0o777,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  assert.equal(await filesystem.readlink!(linked), "hello");
});

test("node virtio-fs adapter detects an ancestor replaced by a symlink", async () => {
  await mkdir(path.join(shared, "safe"));
  const filesystem = new FS(shared);
  const safe = await filesystem.lookup(filesystem.root, "safe");
  assert(safe);

  await rename(path.join(shared, "safe"), path.join(shared, "moved"));
  await symlink(outside, path.join(shared, "safe"));
  await assert.rejects(
    async () => filesystem.lookup(safe, "secret"),
    (error) => error instanceof FSError && error.errno === 13,
  );
});
