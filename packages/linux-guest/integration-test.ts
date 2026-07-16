import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const [modulePath] = Deno.args;
if (!modulePath || Deno.args.length !== 1) {
  throw new Error("usage: integration-test.ts <linux-guest-module>");
}

const { ConsoleDevice, EntropyDevice, SeekMode, SystemError, spawnGuest } =
  await import(
    pathToFileURL(modulePath).href
  );

function closedInput() {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function consoleOutput() {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      Deno.stderr.writeSync(chunk);
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const bootConsole = consoleOutput();
const { machine, fs, exec } = await spawnGuest({
  cpus: 2,
  memoryMib: 192,
  devices: [
    new ConsoleDevice(closedInput(), consoleOutput()),
    new EntropyDevice(),
  ],
  bootConsole,
});

try {
  await assert.rejects(
    fs.writeTextFile("/immutable.txt", "nope"),
    (error: unknown) =>
      error instanceof SystemError &&
      (error as { code?: string }).code === "EROFS",
  );

  await fs.mkdir("/workspace/tree/child", { recursive: true });
  await fs.writeTextFile("/workspace/tree/hello.txt", "hello, guest\n");
  assert.equal(
    await fs.readTextFile("/workspace/tree/hello.txt"),
    "hello, guest\n",
  );

  const info = await fs.stat("/workspace/tree/hello.txt");
  assert.equal(info.isFile, true);
  assert.equal(info.size, 13);

  const entries = [];
  for await (const entry of fs.readDir("/workspace/tree")) entries.push(entry);
  assert.deepEqual(
    entries.map((entry: { name: string }) => entry.name).sort(),
    [
      "child",
      "hello.txt",
    ],
  );

  await fs.symlink("hello.txt", "/workspace/tree/link");
  assert.equal((await fs.lstat("/workspace/tree/link")).isSymlink, true);
  assert.equal(await fs.readLink("/workspace/tree/link"), "hello.txt");
  assert.equal(
    await fs.realPath("/workspace/tree/link"),
    "/workspace/tree/hello.txt",
  );

  await fs.copyFile("/workspace/tree/hello.txt", "/workspace/tree/copied.txt");
  await assert.rejects(
    fs.copyFile("/workspace/tree/hello.txt", "/workspace/tree/hello.txt"),
    (error: unknown) =>
      error instanceof SystemError &&
      (error as { code?: string }).code === "EINVAL",
  );
  assert.equal(
    await fs.readTextFile("/workspace/tree/hello.txt"),
    "hello, guest\n",
  );
  await fs.rename("/workspace/tree/copied.txt", "/workspace/tree/renamed.txt");
  await fs.chmod("/workspace/tree/renamed.txt", 0o600);
  assert.equal(
    (await fs.stat("/workspace/tree/renamed.txt")).mode & 0o777,
    0o600,
  );
  await fs.truncate("/workspace/tree/renamed.txt", 5);
  assert.equal(await fs.readTextFile("/workspace/tree/renamed.txt"), "hello");

  const file = await fs.open("/workspace/tree/open.txt", {
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
  file.close();

  const appended = await fs.open("/workspace/tree/open.txt", { append: true });
  assert.equal(await appended.write(new TextEncoder().encode("ghi")), 3);
  appended.close();
  assert.equal(await fs.readTextFile("/workspace/tree/open.txt"), "abcdefghi");

  const retained = await Promise.all(
    Array.from({ length: 11 }, () => fs.open("/workspace/tree/open.txt")),
  );
  try {
    await assert.rejects(
      fs.open("/workspace/tree/open.txt"),
      (error: unknown) =>
        error instanceof SystemError &&
        (error as { code?: string }).code === "EAGAIN",
    );
    assert.equal((await fs.stat("/workspace/tree/open.txt")).size, 9);
  } finally {
    for (const retainedFile of retained) retainedFile.close();
  }

  const large = new Uint8Array(256 * 1024);
  for (let i = 0; i < large.length; i++) large[i] = i & 0xff;
  await fs.writeFile("/workspace/large.bin", large);
  assert.deepEqual(await fs.readFile("/workspace/large.bin"), large);

  const child = await exec([
    "sh",
    "-c",
    'cat; printf \'%s:%s\' "$GREETING" "$PWD" >&2',
  ], {
    cwd: "/workspace/tree",
    env: { GREETING: "hello" },
  });
  const stdin = child.stdin.getWriter();
  await stdin.write(large);
  await stdin.close();
  const [stdout, stderr, status] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    child.status,
  ]);
  assert.deepEqual(stdout, large);
  assert.equal(new TextDecoder().decode(stderr), "hello:/workspace/tree");
  assert.deepEqual(status, { success: true, code: 0, signal: null });

  const concurrent = await Promise.all([exec(["cat"]), exec(["cat"])]);
  const concurrentOutput = concurrent.map((process) => collect(process.stdout));
  const concurrentError = concurrent.map((process) => collect(process.stderr));
  const concurrentStatus = concurrent.map((process) => process.status);
  assert.equal((await fs.stat("/workspace/large.bin")).size, large.byteLength);
  await Promise.all(
    concurrent.map(async (process, index) => {
      const writer = process.stdin.getWriter();
      await writer.write(
        large.subarray(index * 32 * 1024, (index + 1) * 32 * 1024),
      );
      await writer.close();
    }),
  );
  for (let index = 0; index < concurrent.length; index++) {
    assert.deepEqual(
      await concurrentOutput[index],
      large.subarray(index * 32 * 1024, (index + 1) * 32 * 1024),
    );
    assert.equal((await concurrentError[index]).byteLength, 0);
    assert.deepEqual(await concurrentStatus[index], {
      success: true,
      code: 0,
      signal: null,
    });
  }

  const signalled = await exec(["sleep", "30"]);
  await signalled.kill("SIGTERM");
  assert.deepEqual(await signalled.status, {
    success: false,
    code: 0,
    signal: "SIGTERM",
  });

  const crashed = await exec(["sh", "-c", "kill -SEGV $$"]);
  assert.deepEqual(await crashed.status, {
    success: false,
    code: 0,
    signal: 11,
  });

  const abortController = new AbortController();
  const aborted = await exec(["sleep", "30"], {
    signal: abortController.signal,
  });
  const abortReason = new Error("cancel process");
  abortController.abort(abortReason);
  await assert.rejects(aborted.status, (error: unknown) => error === abortReason);

  const orphaned = await exec([
    "sh",
    "-c",
    "sh -c 'i=0; while [ $i -lt 1000 ]; do i=$((i + 1)); done' &",
  ]);
  assert.deepEqual(await orphaned.status, {
    success: true,
    code: 0,
    signal: null,
  });
  const zombieCheck = await exec([
    "sh",
    "-c",
    'for stat in /proc/[0-9]*/stat; do case "$(cat "$stat")" in *") Z 1 "*) exit 1;; esac; done',
  ]);
  assert.deepEqual(await zombieCheck.status, {
    success: true,
    code: 0,
    signal: null,
  });

  await assert.rejects(
    fs.readFile("/workspace/missing"),
    (error: unknown) =>
      error instanceof SystemError &&
      (error as { code?: string }).code === "ENOENT",
  );

  await fs.remove("/workspace/tree", { recursive: true });
  await assert.rejects(fs.stat("/workspace/tree"));
} finally {
  machine.close();
  await machine.closed;
  const writer = bootConsole.getWriter();
  await writer.write(new Uint8Array());
  writer.releaseLock();
}
