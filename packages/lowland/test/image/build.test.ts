// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { once } from "node:events";
import fs, {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Duplex } from "node:stream";
import test, { type TestContext } from "node:test";
import { bootMachine } from "../../src/machine/index.ts";
import { createNetwork, guestAgent } from "../../src/guest/index.ts";
import { build_image, buildImage, type BuildImageOptions } from "../../src/image/build.ts";
import { rootImage } from "../../src/image/index.ts";
import { busybox_package, jq_package, unsigned_repository } from "./assets.ts";

// These tests never use the network. test/online covers the public
// repository with `pnpm test:online`.

const decoder = new TextDecoder();

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
  const root = writable ? { path: "/", source: path, type: "ext4" } : rootImage(path);
  const guest = guestAgent({ mounts: [root] });
  const machine = await bootMachine({ cpus: 1, plugins: [guest] });
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

// The EROFS superblock at byte 1024 records incompatible features at offset
// 80 and, with compression configured, the algorithms in use at offset 84.
const COMPRESSION_CONFIGS = 0x2;
const ALGORITHMS = { deflate: 1 << 2, lzma: 1 << 1 };

for (const compression of ["deflate", "lzma", "none"] as const) {
  test(`builds an EROFS image with ${compression} compression`, async (t) => {
    const output = await build(t, { packages: [jq_package], compression });
    const image = await readFile(output);
    const superblock = new DataView(image.buffer, image.byteOffset + 1024, 128);
    const incompatible = superblock.getUint32(80, true);
    if (compression === "none") assert.equal(incompatible & COMPRESSION_CONFIGS, 0);
    else assert.equal(superblock.getUint16(84, true), ALGORITHMS[compression]);
    const guest = await boot(t, output);

    const result = await guest.run(["jq", ".answer", "/srv/input.json"]);
    assert.deepEqual(result.status, { success: true, code: 0, signal: null });
    assert.equal(decoder.decode(result.stdout), "42\n");
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

// Taking root ownership clears setuid and setgid, which the build restores.
// Sandboxes such as Nix's refuse to create those modes; the test then skips.
test("keeps setuid and setgid on copied files", async (t) => {
  const stage = await mkdtemp(join(tmpdir(), "lowland-image-stage-"));
  t.after(() => rm(stage, { recursive: true, force: true }));
  await mkdir(join(stage, "bin"));
  await writeFile(join(stage, "bin", "setuid"), "setuid\n");
  await writeFile(join(stage, "bin", "plain"), "plain\n");
  const setgid = join(stage, "setgid");
  await writeFile(setgid, "setgid\n");
  try {
    await chmod(join(stage, "bin", "setuid"), 0o4755);
    await chmod(setgid, 0o2755);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("the host cannot create setuid or setgid files");
    return;
  }
  const output = await build(t, {
    packages: [busybox_package],
    files: { "/opt": join(stage, "bin"), "/usr/bin/setgid": setgid },
  });
  const guest = await boot(t, output);
  const permissions = async (path: string) =>
    ((await guest.fs.stat(path)).mode & 0o7777).toString(8);

  assert.equal(await permissions("/opt/setuid"), "4755");
  assert.equal(await permissions("/opt/plain"), "644");
  assert.equal(await permissions("/usr/bin/setgid"), "2755");
});

test("labels an image only when asked", async (t) => {
  // EROFS keeps its 16-byte volume name 64 bytes into its superblock.
  const label = async (path: string) => {
    const bytes = await readFile(path);
    return decoder.decode(bytes.subarray(1024 + 64, 1024 + 80)).replace(/\0+$/, "");
  };
  assert.equal(await label(await build(t, { packages: [busybox_package] })), "");
  const labeled = await build(t, { packages: [busybox_package], label: "DATA" });
  assert.equal(await label(labeled), "DATA");
});

test("rejects unsupported compressions", async () => {
  await assert.rejects(
    buildImage({ packages: ["jq"], compression: "lz4" as "none", output: "unused" }),
    /unsupported image compression "lz4", expected one of: deflate, lzma, none/,
  );
});

test("rejects unsupported formats", async () => {
  await assert.rejects(
    buildImage({ packages: ["jq"], format: "xfs" as "ext4", output: "unused" }),
    /unsupported image format "xfs", expected one of: erofs, ext4/,
  );
});

async function scratch(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "lowland-image-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("rejects package names that apk would misread", async () => {
  for (const name of ["--allow-untrusted", "-X", "jq curl", "jq\n", ""]) {
    await assert.rejects(
      buildImage({ packages: [name], output: "unused" }),
      new TypeError(`invalid package name: ${JSON.stringify(name)}`),
    );
  }
});

test("keeps an existing output when a build fails", async (t) => {
  const directory = await scratch(t);
  const output = join(directory, "image.erofs");
  await writeFile(output, "previous\n");
  await assert.rejects(buildImage({ packages: [join(directory, "missing.apk")], output }), {
    code: "ENOENT",
  });
  assert.equal(await readFile(output, "utf8"), "previous\n");
  assert.deepEqual(await readdir(directory), ["image.erofs"]);
});

test("replaces an existing output atomically", async (t) => {
  const directory = await scratch(t);
  const output = join(directory, "image.erofs");
  await writeFile(output, "previous\n");
  // A reader of the old file keeps seeing it, so the build never wrote to it.
  await using previous = await open(output, "r");
  await buildImage({ packages: [busybox_package], output });
  assert.equal(await previous.readFile("utf8"), "previous\n");
  const header = (await readFile(output)).subarray(1024, 1028);
  assert.equal(Buffer.from(header).readUInt32LE(), 0xe0f5e1e2);
  assert.deepEqual(await readdir(directory), ["image.erofs"]);
});

test("installs a local package whose file name needs quoting", async (t) => {
  const directory = await scratch(t);
  const named = join(directory, "jq with spaces\nand a newline.apk");
  await copyFile(jq_package, named);
  const output = join(directory, "image.erofs");
  await buildImage({ packages: [named], output });
  const guest = await boot(t, output);
  const result = await guest.run(["jq", "-n", "6 * 7"]);
  assert.deepEqual(result.status, { success: true, code: 0, signal: null });
  assert.equal(decoder.decode(result.stdout), "42\n");
});

test("copies a read-only source directory and cleans up after it", async (t) => {
  const directory = await scratch(t);
  const source = join(directory, "data");
  await mkdir(source);
  await writeFile(join(source, "value"), "read-only\n", { mode: 0o444 });
  await chmod(source, 0o555);
  // The build stages its inputs under the temporary directory.
  const temporary = join(directory, "tmp");
  await mkdir(temporary);
  const output = join(directory, "image.erofs");
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  let mode: number;
  try {
    await buildImage({ packages: [busybox_package], files: { "/srv/data": source }, output });
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    mode = (await stat(source)).mode & 0o777;
    // Let the scratch directory be removed.
    await chmod(source, 0o755);
  }
  assert.equal(mode, 0o555);
  assert.deepEqual(await readdir(temporary), []);
  const guest = await boot(t, output);
  assert.equal(await guest.fs.readTextFile("/srv/data/value"), "read-only\n");
});

test("cleans up the output even when removing the staged inputs fails", async (t) => {
  const directory = await scratch(t);
  const broken = join(directory, "broken.apk");
  await writeFile(broken, "not an apk\n");
  const output = join(directory, "image.erofs");
  // Fail only the removal of the staging directory, which comes before the
  // temporary output's.
  const real = fs.rm;
  const staged: string[] = [];
  t.mock.method(fs, "rm", (path: string, options: object) => {
    if (/^lowland-image-\w{6}$/.test(basename(path))) {
      staged.push(path);
      return Promise.reject(new Error("cannot remove the staged inputs"));
    }
    return real(path, options);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const path of staged) await rm(path, { recursive: true, force: true });
  });
  const error = await buildImage({ packages: [broken], output }).then(
    () => assert.fail("the build succeeded"),
    (error: unknown) => error,
  );
  assert.ok(error instanceof AggregateError, String(error));
  assert.match(String(error.errors[0]), /^Error: image build failed:\n/);
  assert.equal(String(error.errors[1]), "Error: cannot remove the staged inputs");
  assert.equal(staged.length, 1);
  assert.deepEqual(await readdir(directory), ["broken.apk"]);
});

// The fixture's address is never routed: every connection reaches the server.
const FIXTURE = "http://203.0.113.1/wasm32/Packages.adb";

async function serve_unsigned_repository(t: TestContext) {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url ?? "");
    try {
      const body = await readFile(join(unsigned_repository, request.url ?? "/"));
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const network = () =>
    createNetwork({
      async connectTcp(session) {
        const socket = createConnection({ host: "127.0.0.1", port, signal: session.signal });
        await once(socket, "connect");
        const streams = Duplex.toWeb(socket);
        await Promise.all([
          session.readable.pipeTo(streams.writable as WritableStream<Uint8Array>),
          (streams.readable as ReadableStream<Uint8Array>).pipeTo(session.writable),
        ]);
      },
      resolveDns: () => Promise.reject(new Error("the fixture has no names")),
    });
  return { requests, repository: { url: FIXTURE, network } };
}

test("rejects an unsigned repository even with local packages", async (t) => {
  const directory = await scratch(t);
  const { requests, repository } = await serve_unsigned_repository(t);
  const output = join(directory, "image.erofs");
  await assert.rejects(
    build_image({ packages: ["jq", busybox_package], output }, repository),
    /^Error: image build failed:\n.*UNTRUSTED/s,
  );
  assert.ok(requests.includes("/wasm32/Packages.adb"), `requests: ${requests.join(", ")}`);
  assert.deepEqual(await readdir(directory), []);
});
