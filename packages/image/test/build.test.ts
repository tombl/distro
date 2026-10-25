// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { blockDevice, bootMachine } from "@lowland/kernel";
import { guestAgent } from "@lowland/guest";
import { buildImage, type BuildImageOptions } from "../src/build.ts";
import { jq_package } from "./assets.ts";

const decoder = new TextDecoder();

// The Nix sandbox has no network, so tests that resolve packages from the
// public repository skip there.
const online = await lookup("assets.low.land").then(
  () => true,
  () => false,
);

async function build(t: TestContext, options: Omit<BuildImageOptions, "output">) {
  const directory = await mkdtemp(join(tmpdir(), "lowland-image-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.json");
  await writeFile(input, '{"answer": 42}\n');
  const output = join(directory, "image.ext4");
  await buildImage({
    ...options,
    files: { "/srv/input.json": input, ...options.files },
    size: "16M",
    output,
  });
  return output;
}

async function boot(t: TestContext, path: string) {
  const disk = new Uint8Array(await readFile(path));
  const guest = guestAgent();
  const machine = await bootMachine({
    cpus: 1,
    plugins: [
      blockDevice({
        capacity: disk.byteLength,
        read(offset, target) {
          const source = disk.subarray(offset, offset + target.byteLength);
          target.set(source);
          return source.byteLength;
        },
        write(offset, data) {
          disk.set(data, offset);
          return data.byteLength;
        },
        flush() {},
      }),
      guest,
    ],
  });
  t.after(() => machine[Symbol.asyncDispose]());
  return guest;
}

for (const format of ["erofs", "ext4"] as const) {
  test(`builds an ${format} image from a local package`, async (t) => {
    const output = await build(t, {
      packages: [jq_package],
      links: { "/usr/bin/query": "/bin/jq" },
      format,
    });
    const { size } = await stat(output);
    if (format === "ext4") assert.equal(size, 16 * 2 ** 20);
    else assert.ok(size < 16 * 2 ** 20 && size % 4096 === 0, `EROFS image is ${size} bytes`);
    const guest = await boot(t, output);

    const result = await guest.run(["query", ".answer", "/srv/input.json"]);
    assert.deepEqual(result.status, { success: true, code: 0, signal: null });
    assert.equal(decoder.decode(result.stdout), "42\n");

    for (const path of ["/dev", "/proc", "/sys", "/tmp", "/root", "/run", "/mnt"]) {
      assert.ok((await guest.fs.stat(path)).isDirectory, path);
    }
    assert.equal(
      await guest.fs.readTextFile("/etc/apk/repositories"),
      "http://assets.low.land/apk/wasm32/Packages.adb\n",
    );
  });
}

test("builds an image from the public repository", { skip: !online && "offline" }, async (t) => {
  const output = await build(t, {
    packages: ["busybox", "jq"],
    files: {
      "/usr/local/bin/answer": {
        source: new URL("./answer.sh", import.meta.url).pathname,
        mode: "0755",
      },
    },
  });
  const guest = await boot(t, output);

  const result = await guest.run(["/usr/local/bin/answer"]);
  assert.deepEqual(result.status, { success: true, code: 0, signal: null });
  assert.equal(decoder.decode(result.stdout), "42\n");
});

test("rejects unsupported formats", async () => {
  await assert.rejects(
    buildImage({ packages: ["jq"], format: "xfs" as "ext4", output: "unused" }),
    /unsupported image format "xfs", expected one of: erofs, ext4/,
  );
});
