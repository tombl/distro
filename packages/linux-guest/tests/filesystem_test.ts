import assert from "node:assert/strict";
import { SeekMode, SystemError } from "../src/index.ts";
import { guest_test } from "./fixture.ts";
import { pattern_bytes } from "./helpers.ts";

guest_test("filesystem", async (t, fixture) => {
  const { fs } = await fixture.spawn();

  const directory = "/workspace/filesystem";
  await fs.mkdir(`${directory}/child`, { recursive: true });

  await t.step("reads and writes text files", async () => {
    await fs.writeTextFile(`${directory}/hello.txt`, "hello, guest\n");
    assert.equal(await fs.readTextFile(`${directory}/hello.txt`), "hello, guest\n");
  });

  await t.step("stats files", async () => {
    const info = await fs.stat(`${directory}/hello.txt`);
    assert.equal(info.isFile, true);
    assert.equal(info.size, 13);
  });

  await t.step("reads directories", async () => {
    const entries = [];
    for await (const entry of fs.readDir(directory)) entries.push(entry);
    assert.deepEqual(entries.map((entry) => entry.name).sort(), ["child", "hello.txt"]);
  });

  await t.step("resolves symbolic links", async () => {
    await fs.symlink("hello.txt", `${directory}/link`);
    assert.equal((await fs.lstat(`${directory}/link`)).isSymlink, true);
    assert.equal(await fs.readLink(`${directory}/link`), "hello.txt");
    assert.equal(await fs.realPath(`${directory}/link`), `${directory}/hello.txt`);
  });

  await t.step("copies and renames files", async () => {
    await fs.copyFile(`${directory}/hello.txt`, `${directory}/copied.txt`);
    assert.equal(await fs.readTextFile(`${directory}/copied.txt`), "hello, guest\n");
    await fs.rename(`${directory}/copied.txt`, `${directory}/renamed.txt`);
    assert.equal(await fs.readTextFile(`${directory}/renamed.txt`), "hello, guest\n");
  });

  await t.step("rejects copying a file onto itself", async () => {
    await assert.rejects(
      fs.copyFile(`${directory}/hello.txt`, `${directory}/hello.txt`),
      (error) => error instanceof SystemError && error.code === "EINVAL",
    );
    assert.equal(await fs.readTextFile(`${directory}/hello.txt`), "hello, guest\n");
  });

  await t.step("changes file modes and sizes", async () => {
    await fs.chmod(`${directory}/renamed.txt`, 0o600);
    assert.equal((await fs.stat(`${directory}/renamed.txt`)).mode & 0o777, 0o600);
    await fs.truncate(`${directory}/renamed.txt`, 5);
    assert.equal(await fs.readTextFile(`${directory}/renamed.txt`), "hello");
  });

  await t.step("reads, writes, seeks, and syncs open files", async () => {
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

  await t.step("appends to open files", async () => {
    const appended = await fs.open(`${directory}/open.txt`, { append: true });
    assert.equal(await appended.write(new TextEncoder().encode("ghi")), 3);
    await appended.close();
    assert.equal(await fs.readTextFile(`${directory}/open.txt`), "abcdefghi");
  });

  // Open files are plain guest fds. More opens than the agent has workers
  // must coexist with other traffic.
  await t.step("keeps many file descriptors open", async () => {
    const retained = await Promise.all(
      Array.from({ length: 32 }, () => fs.open(`${directory}/open.txt`)),
    );
    try {
      assert.equal((await fs.stat(`${directory}/open.txt`)).size, 9);
    } finally {
      await Promise.all(retained.map((retained_file) => retained_file.close()));
    }
  });

  await t.step("reads and writes large binary files", async () => {
    const large = pattern_bytes(256 * 1024);
    await fs.writeFile(`${directory}/large.bin`, large);
    assert.deepEqual(await fs.readFile(`${directory}/large.bin`), large);
  });

  await t.step("reports missing files", async () => {
    await assert.rejects(
      fs.readFile(`${directory}/missing`),
      (error) => error instanceof SystemError && error.code === "ENOENT",
    );
  });

  await fs.remove(directory, { recursive: true });
  await assert.rejects(fs.stat(directory));
});
