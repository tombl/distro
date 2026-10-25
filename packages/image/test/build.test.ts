// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import { bootMachine } from "@lowland/kernel";
import { guestAgent } from "@lowland/guest";
import { buildImage, type BuildImageOptions } from "../src/build.ts";
import { rootImage } from "../src/index.ts";
import { busybox_package, jq_package } from "./assets.ts";

const decoder = new TextDecoder();

// Tests that resolve packages from the public repository skip offline, and
// inside Nix builds even when they have network (as CI's do): the repository
// is whatever main last published, so checks must not depend on it.
const online =
  !process.env.NIX_BUILD_TOP &&
  (await lookup("assets.low.land").then(
    () => true,
    () => false,
  ));

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

async function boot(t: TestContext, path: string, writable = false) {
  const guest = guestAgent();
  const machine = await bootMachine({
    cpus: 1,
    plugins: [rootImage(path, { writable }), guest],
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
    const guest = await boot(t, output, format === "ext4");

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

// Mirrors mkImage's modes check: a 0700 staged directory merged onto /usr.
for (const mode of [undefined, "0750"]) {
  test(`merges a directory into an existing one ${mode ? `with mode ${mode}` : "without a mode"}`, async (t) => {
    const stage = await mkdtemp(join(tmpdir(), "lowland-image-stage-"));
    t.after(() => rm(stage, { recursive: true, force: true }));
    await mkdir(join(stage, "bin"));
    await writeFile(join(stage, "bin", "tool"), "staged\n");
    await writeFile(join(stage, "bin", "readonly"), "readonly\n", { mode: 0o444 });
    await chmod(join(stage, "bin"), 0o755);
    await chmod(stage, 0o700);
    const tool = join(stage, "..", `${basename(stage)}-tool`);
    await writeFile(tool, "override\n");
    t.after(() => rm(tool, { force: true }));
    const output = await build(t, {
      packages: [busybox_package],
      // Listed child first: entries still apply parent before child.
      files: { "/usr/bin/tool": tool, "/usr": mode ? { source: stage, mode } : stage },
    });
    const guest = await boot(t, output);
    const permissions = async (path: string) =>
      ((await guest.fs.stat(path)).mode & 0o7777).toString(8);

    assert.equal(await permissions("/usr"), mode ? "750" : "755");
    assert.equal(await permissions("/usr/bin"), "755");
    assert.equal(await permissions("/usr/bin/readonly"), "644");
    assert.equal(await guest.fs.readTextFile("/usr/bin/tool"), "override\n");
    // The merge lands beside the existing contents rather than nested.
    assert.ok((await guest.fs.stat("/usr/sbin")).isDirectory);
    await assert.rejects(guest.fs.stat("/usr/1"));
  });
}

test(
  "builds an image from the public repository",
  { skip: !online && "offline or in a Nix build" },
  async (t) => {
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
  },
);

test("rejects unsupported formats", async () => {
  await assert.rejects(
    buildImage({ packages: ["jq"], format: "xfs" as "ext4", output: "unused" }),
    /unsupported image format "xfs", expected one of: erofs, ext4/,
  );
});
