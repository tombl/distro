import assert from "node:assert/strict";
import { SeekMode, SystemError } from "../src/index.ts";
import { guest_test } from "./fixture.ts";
import { pattern_bytes } from "./helpers.ts";

guest_test("filesystem", async (t, fixture) => {
  const { fs } = await fixture.spawn();

  const directory = "/workspace/filesystem";
  await fs.mkdir(`${directory}/child`, { recursive: true });

  await t.test("reads and writes text files", async () => {
    await fs.writeTextFile(`${directory}/hello.txt`, "hello, guest\n");
    assert.equal(await fs.readTextFile(`${directory}/hello.txt`), "hello, guest\n");
  });

  await t.test("stats files", async () => {
    const info = await fs.stat(`${directory}/hello.txt`);
    assert.equal(info.isFile, true);
    assert.equal(info.size, 13);
  });

  await t.test("reads directories", async () => {
    const entries = [];
    for await (const entry of fs.readDir(directory)) entries.push(entry);
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ["child", "hello.txt"]);
  });

  await t.test("resolves symbolic links", async () => {
    await fs.symlink("hello.txt", `${directory}/link`);
    assert.equal((await fs.lstat(`${directory}/link`)).isSymlink, true);
    assert.equal(await fs.readLink(`${directory}/link`), "hello.txt");
    assert.equal(await fs.realPath(`${directory}/link`), `${directory}/hello.txt`);
  });

  await t.test("copies and renames files", async () => {
    await fs.copyFile(`${directory}/hello.txt`, `${directory}/copied.txt`);
    assert.equal(await fs.readTextFile(`${directory}/copied.txt`), "hello, guest\n");
    await fs.rename(`${directory}/copied.txt`, `${directory}/renamed.txt`);
    assert.equal(await fs.readTextFile(`${directory}/renamed.txt`), "hello, guest\n");
  });

  await t.test("rejects copying a file onto itself", async () => {
    await assert.rejects(
      fs.copyFile(`${directory}/hello.txt`, `${directory}/hello.txt`),
      (error) => error instanceof SystemError && error.code === "EINVAL",
    );
    assert.equal(await fs.readTextFile(`${directory}/hello.txt`), "hello, guest\n");
  });

  await t.test("changes file modes and sizes", async () => {
    await fs.chmod(`${directory}/renamed.txt`, 0o600);
    assert.equal((await fs.stat(`${directory}/renamed.txt`)).mode & 0o777, 0o600);
    await fs.truncate(`${directory}/renamed.txt`, 5);
    assert.equal(await fs.readTextFile(`${directory}/renamed.txt`), "hello");
  });

  await t.test("reads, writes, seeks, and syncs open files", async () => {
    const file = await fs.open(`${directory}/open.txt`, {
      create: true,
      read: true,
      truncate: true,
      write: true,
    });
    assert.equal(await file.write(new TextEncoder().encode("abcdef")), 6);
    assert.equal(await file.seek(-3, SeekMode.End), 3);
    const tail = new Uint8Array(3);
    assert.equal(await file.read(tail), 3);
    assert.equal(new TextDecoder().decode(tail), "def");
    await file.sync();
    await file.close();
  });

  await t.test("appends to open files", async () => {
    const appended = await fs.open(`${directory}/open.txt`, { append: true });
    assert.equal(await appended.write(new TextEncoder().encode("ghi")), 3);
    await appended.close();
    assert.equal(await fs.readTextFile(`${directory}/open.txt`), "abcdefghi");
  });

  await t.test("finishes queued file operations before closing", async () => {
    const queued = await fs.open(`${directory}/queued.txt`, {
      create: true,
      read: true,
      truncate: true,
      write: true,
    });
    const written = queued.write(new TextEncoder().encode("queued"));
    const sought = queued.seek(0, SeekMode.Start);
    const contents = new Uint8Array(6);
    const read = queued.read(contents);
    await queued.close();
    assert.equal(await written, 6);
    assert.equal(await sought, 0);
    assert.equal(await read, 6);
    assert.equal(new TextDecoder().decode(contents), "queued");
  });

  await t.test("rejects a file in a recursive directory path", async () => {
    const file = `${directory}/not-a-directory`;
    await fs.writeTextFile(file, "file");
    await assert.rejects(
      fs.mkdir(file, { recursive: true }),
      (error) => error instanceof SystemError && error.code === "ENOTDIR",
    );
  });

  // Open files are plain guest fds. More opens than the agent has workers
  // must coexist with other traffic.
  await t.test("keeps many file descriptors open", async () => {
    const retained = await Promise.all(
      Array.from({ length: 32 }, () => fs.open(`${directory}/open.txt`)),
    );
    try {
      assert.equal((await fs.stat(`${directory}/open.txt`)).size, 9);
    } finally {
      await Promise.all(retained.map((retained_file) => retained_file.close()));
    }
  });

  await t.test("reads and writes large binary files", async () => {
    const large = pattern_bytes(256 * 1024);
    await fs.writeFile(`${directory}/large.bin`, large);
    assert.deepEqual(await fs.readFile(`${directory}/large.bin`), large);
  });

  // A string is not FileData; it must be rejected loudly rather than writing
  // an empty file, and the target must not be created as a side effect.
  await t.test("rejects a string passed to writeFile", async () => {
    await assert.rejects(
      // @ts-expect-error exercising the untyped-JS path that used to write 0 bytes
      fs.writeFile(`${directory}/string.txt`, "not bytes"),
      (error) => error instanceof TypeError,
    );
    await assert.rejects(
      fs.stat(`${directory}/string.txt`),
      (error) => error instanceof SystemError && error.code === "ENOENT",
    );
  });

  await t.test("reports missing files", async () => {
    await assert.rejects(
      fs.readFile(`${directory}/missing`),
      (error) => error instanceof SystemError && error.code === "ENOENT",
    );
  });

  await fs.remove(directory, { recursive: true });
  await assert.rejects(fs.stat(directory));
});
