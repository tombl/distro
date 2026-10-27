// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildImage } from "../src/image/build.ts";
import { GuestBootError } from "../src/guest/index.ts";
import { createNetwork } from "../src/machine/index.ts";
import { NodeFS } from "../src/node/index.ts";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { rootImage } from "../src/image/index.ts";
import { Linux, type LinuxOptions } from "../src/linux.ts";
import { busybox_package, ext4_root, scratch_directory } from "./assets.ts";

const cli = fileURLToPath(new URL("../src/cli/cli.ts", import.meta.url));

/** Runs the CLI with `input` on stdin and collects its output. */
function lowland(args: string[], input = "") {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { stdio: "pipe" });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input);
    },
  );
}

/** An HTTP server on the host's loopback that answers every request with `body`. */
async function http_server(body: string) {
  const server = createServer((_, response) => response.end(body));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    [Symbol.asyncDispose]: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const scratch = await scratch_directory();
let data_disk: string;

before(async () => {
  data_disk = join(scratch.path, "data.ext4");
  await buildImage({
    packages: [busybox_package],
    format: "ext4",
    label: "DATA",
    size: "16M",
    output: data_disk,
  });
});

after(() => scratch[Symbol.asyncDispose]());

describe("lowland run", () => {
  it("runs a command", async () => {
    const result = await lowland(["run", "echo", "hello", "-n"]);
    assert.deepEqual(result, { status: 0, stdout: "hello -n\n", stderr: "" });
  });

  it("reports the command's exit status", async () => {
    assert.equal((await lowland(["run", "sh", "-c", "exit 3"])).status, 3);
    assert.equal((await lowland(["run", "--", "sh", "-c", "kill -TERM $$"])).status, 143);
  });

  it("exits 127 for a missing command and 126 for one that cannot run", async () => {
    const missing = await lowland(["run", "/no/such/command"]);
    assert.equal(missing.status, 127);
    assert.equal(missing.stderr, "lowland run: /no/such/command: command not found\n");
    const unknown = await lowland(["run", "no-such-command"]);
    assert.equal(unknown.status, 127);
    assert.equal(unknown.stderr, "lowland run: no-such-command: command not found\n");
    const unexecutable = await lowland(["run", "/etc"]);
    assert.equal(unexecutable.status, 126);
    assert.match(unexecutable.stderr, /^lowland run: \/etc: cannot execute/);
  });

  it("exits 125 when the machine cannot boot", async () => {
    const result = await lowland(["run", "--image", join(scratch.path, "missing.erofs"), "true"]);
    assert.equal(result.status, 125);
    assert.match(result.stderr, /^lowland run: /);
  });

  it("exits 125 for argument errors", async () => {
    const result = await lowland(["run", "--disk", "nowhere"]);
    assert.equal(result.status, 125);
    assert.match(result.stderr, /^lowland run: --disk expects path:guest\[:ro\]/);
  });

  it("passes stdin through and keeps stdout and stderr separate", async () => {
    const result = await lowland(
      ["run", "--env", "GREETING=hi", "sh", "-c", 'cat; echo "$GREETING" >&2'],
      "line one\nline two\n",
    );
    assert.deepEqual(result, { status: 0, stdout: "line one\nline two\n", stderr: "hi\n" });
  });

  it("runs a shell when no command is given", async () => {
    const result = await lowland(["run"], "echo from the shell\nexit 4\n");
    assert.equal(result.status, 4);
    assert.equal(result.stdout, "from the shell\n");
  });

  it("sets the working directory, / by default", async () => {
    assert.equal((await lowland(["run", "pwd"])).stdout, "/\n");
    assert.equal((await lowland(["run", "--cwd", "/etc", "pwd"])).stdout, "/etc\n");
    assert.equal((await lowland(["run", "-w", "/etc", "pwd"])).stdout, "/etc\n");
  });

  it("boots the requested number of CPUs", async () => {
    const result = await lowland(["run", "--cpus", "2", "nproc"]);
    assert.deepEqual(result, { status: 0, stdout: "2\n", stderr: "" });
  });

  it("reaches the host's network with --network host", async () => {
    await using server = await http_server("from the host\n");
    const url = `http://192.0.2.1:${server.port}/`;
    const result = await lowland(["run", "--network", "host", "wget", "-qO-", url]);
    assert.deepEqual(result, { status: 0, stdout: "from the host\n", stderr: "" });
    const isolated = await lowland(["run", "wget", "-qO-", url]);
    assert.notEqual(isolated.status, 0);
  });

  it("keeps sending to a host peer that has finished sending", async () => {
    // The server sends a line and half-closes; the guest reads to the end
    // and only then replies.
    const server = createNetServer({ allowHalfOpen: true }, (socket) => {
      let received = "";
      socket.setEncoding("utf8").on("data", (chunk) => (received += chunk));
      socket.on("end", () => {
        replies.push(received);
        socket.end();
      });
      socket.end("ready\n");
    });
    const replies: string[] = [];
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const result = await lowland([
        "run",
        "--network",
        "host",
        "nc",
        "192.0.2.1",
        String(port),
        "-e",
        "sh",
        "-c",
        "cat >/tmp/received; echo after $(cat /tmp/received)",
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(replies, ["after ready\n"]);
    } finally {
      server.close();
    }
  });

  it("shares a host directory both ways", async () => {
    const shared = join(scratch.path, "shared");
    await mkdir(shared);
    await writeFile(join(shared, "in.txt"), "from the host\n");
    const result = await lowland([
      "run",
      "-v",
      `${shared}:/work`,
      "sh",
      "-c",
      "cat /work/in.txt && echo from the guest > /work/out.txt",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "from the host\n");
    assert.equal(await readFile(join(shared, "out.txt"), "utf8"), "from the guest\n");
  });

  it("shares a host directory read-only", async () => {
    const shared = join(scratch.path, "read-only");
    await mkdir(shared);
    const result = await lowland(["run", "--mount", `${shared}:/work:ro`, "touch", "/work/x"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Read-only file system/);
  });

  it("persists writes to an ext4 disk", async () => {
    const write = await lowland([
      "run",
      "--disk",
      `${data_disk}:/data`,
      "sh",
      "-c",
      "echo kept > /data/note",
    ]);
    assert.equal(write.status, 0, write.stderr);
    const read = await lowland(["run", "--disk", `${data_disk}:/data:ro`, "cat", "/data/note"]);
    assert.deepEqual(read, { status: 0, stdout: "kept\n", stderr: "" });
  });

  it("flushes a disk when a host reader closes the output early", async () => {
    const child = spawn(
      process.execPath,
      [cli, "run", "--disk", `${data_disk}:/data`, "sh", "-c", "echo early > /data/epipe; yes"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    // Like `| head -n 1`: read the first chunk, then close the pipe.
    child.stdout.once("data", () => child.stdout.destroy());
    const status = await new Promise((resolve) => child.on("close", resolve));
    // The command's own status passes through: SIGPIPE kills yes, as it
    // would on the host.
    assert.equal(status, 141, stderr);
    assert.doesNotMatch(stderr, /lowland|Uncaught/);
    const read = await lowland(["run", "--disk", `${data_disk}:/data:ro`, "cat", "/data/epipe"]);
    assert.equal(read.stdout, "early\n");
  });

  it("does not wait for background processes that keep the output open", async () => {
    const started = performance.now();
    const result = await lowland(["run", "sh", "-c", "echo foreground; sleep 1000 &"]);
    assert.deepEqual(result, { status: 0, stdout: "foreground\n", stderr: "" });
    assert.ok(performance.now() - started < 60_000);
  });

  it("delivers all output to a host reader that is slow to read", async () => {
    const child = spawn(process.execPath, [cli, "run", "sh", "-c", "yes | head -c 1048576"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let length = 0;
    // Stall the reader well past the grace period after the command exits.
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 2000);
    child.stdout.on("data", (chunk: Buffer) => (length += chunk.byteLength));
    const status = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(status, 0);
    assert.equal(length, 1048576);
  });

  it("fails when its output cannot be written", async () => {
    await using full = await open("/dev/full", "w");
    const child = spawn(process.execPath, [cli, "run", "echo", "lost"], {
      stdio: ["ignore", full.fd, "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const status = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(status, 125);
    assert.match(stderr, /^lowland run: .*ENOSPC/);
  });

  it("reports a missing host directory", async () => {
    const result = await lowland([
      "run",
      "--mount",
      `${join(scratch.path, "absent")}:/work`,
      "true",
    ]);
    assert.equal(result.status, 125);
    assert.match(result.stderr, /absent is not a directory/);
  });

  it("does not change a read-only disk", async () => {
    const before = await sha256(data_disk);
    const result = await lowland(["run", "--disk", `${data_disk}:/data:ro`, "touch", "/data/x"]);
    assert.notEqual(result.status, 0);
    assert.equal(await sha256(data_disk), before);
  });

  it("attaches a root image as a disk", async () => {
    const root = await ext4_root(scratch.path);
    const result = await lowland([
      "run",
      "--disk",
      `${root}:/data:ro`,
      "test",
      "-x",
      "/data/bin/sh",
    ]);
    assert.equal(result.status, 0, result.stderr);
  });

  it("reports why a disk did not mount", async () => {
    const empty = join(scratch.path, "empty.img");
    await writeFile(empty, new Uint8Array(1024 * 1024));
    const result = await lowland(["run", "--disk", `${empty}:/data`, "true"]);
    assert.equal(result.status, 125);
    assert.match(result.stderr, /^lowland run: mounting m\d+ \(.*empty\.img\) at \/data: EINVAL/);
  });

  it("never changes the root image", async () => {
    const root = await ext4_root(scratch.path);
    const before = await sha256(root);
    const write = await lowland(["run", "--image", root, "sh", "-c", "echo x > /etc/changed"]);
    assert.equal(write.status, 0, write.stderr);
    const read = await lowland(["run", "--image", root, "test", "-e", "/etc/changed"]);
    assert.equal(read.status, 1);
    assert.equal(await sha256(root), before);
  });
});

describe("Linux", () => {
  it("runs commands and exposes the guest filesystem", async () => {
    await using linux = await Linux.create({ image: rootImage() });
    await linux.fs.writeFile("/tmp/greeting", new TextEncoder().encode("hello"));
    const result = await linux.run(["cat", "/tmp/greeting"]);
    assert.equal(result.status.success, true);
    assert.equal(new TextDecoder().decode(result.stdout), "hello");
    const pwd = await linux.run(["pwd"]);
    assert.equal(new TextDecoder().decode(pwd.stdout), "/\n");
  });

  it("bounds the stdin it buffers for a command that does not read", async () => {
    await using linux = await Linux.create({ image: rootImage() });
    const child = await linux.spawn(["sleep", "30"]);
    const writer = child.stdin.getWriter();
    const write = writer.write(new Uint8Array(4 * 1024 * 1024));
    const settled = await Promise.race([
      write.then(() => true),
      new Promise((resolve) => setTimeout(resolve, 1000, false)),
    ]);
    assert.equal(settled, false);
    // Aborting must not wait behind the blocked write: it kills the command.
    const aborted = writer.abort();
    write.catch(() => {});
    const status = await Promise.race([
      child.status.then(
        () => "settled",
        () => "settled",
      ),
      new Promise((resolve) => setTimeout(resolve, 10_000, "pending")),
    ]);
    assert.equal(status, "settled");
    await aborted.catch(() => {});
  });

  it("flushes writes through a file handle left open at disposal", async () => {
    const linux = await Linux.create({
      image: rootImage(),
      disks: [{ source: data_disk, path: "/data" }],
    });
    const file = await linux.fs.open("/data/open-handle", { write: true, create: true });
    await file.write(new TextEncoder().encode("still open"));
    await linux[Symbol.asyncDispose]();
    // The open file kept the disk from unmounting, so its journal needs
    // recovery, which read-only storage cannot have.
    await assert.rejects(
      Linux.create({
        image: rootImage(),
        disks: [{ source: data_disk, path: "/data", readOnly: true }],
      }),
      (error) =>
        error instanceof GuestBootError &&
        /write access unavailable, cannot proceed/.test(error.kernelLog),
    );
    await using reader = await Linux.create({
      image: rootImage(),
      disks: [{ source: data_disk, path: "/data" }],
    });
    assert.equal(await reader.fs.readTextFile("/data/open-handle"), "still open");
  });

  it("flushes disks on disposal while commands hold every process slot", async () => {
    const linux = await Linux.create({
      image: rootImage(),
      disks: [{ source: data_disk, path: "/data" }],
    });
    await linux.fs.writeFile("/data/slots", new TextEncoder().encode("flushed"));
    for (let i = 0; i < 8; i++) await linux.spawn(["sleep", "1000"], { cwd: "/data" });
    await linux[Symbol.asyncDispose]();
    // Disposal waits for the machine itself to shut down.
    const closed = await Promise.race([
      linux.closed.then(() => true),
      Promise.resolve().then(() => false),
    ]);
    assert.equal(closed, true);
    await using reader = await Linux.create({
      image: rootImage(),
      disks: [{ source: data_disk, path: "/data", readOnly: true }],
    });
    assert.equal(await reader.fs.readTextFile("/data/slots"), "flushed");
  });

  it("needs an image, so only lowland/image brings in the canonical one", async () => {
    await assert.rejects(
      Linux.create({} as LinuxOptions),
      /needs an image, such as rootImage\(\) from lowland\/image/,
    );
    await assert.rejects(
      Linux.create({ image: { ...rootImage(), path: "/data" } }),
      /the image must be mounted at \/, not \/data/,
    );
  });

  it("rejects relative and duplicate guest paths", async () => {
    const source = new NodeFS(".");
    await assert.rejects(
      Linux.create({ image: rootImage(), mounts: [{ source, path: "work" }] }),
      /must be absolute/,
    );
    await assert.rejects(
      Linux.create({
        image: rootImage(),
        mounts: [
          { source, path: "/work" },
          { source, path: "/work" },
        ],
      }),
      /two mounts target \/work/,
    );
  });

  it("attaches disks and filesystems from objects rather than paths", async () => {
    const bytes = new Uint8Array(await readFile(data_disk));
    const shared = join(scratch.path, "objects");
    await mkdir(shared);
    {
      await using linux = await Linux.create({
        image: rootImage(),
        disks: [{ source: bytes, path: "/data" }],
        mounts: [{ source: new NodeFS(shared), path: "/work" }],
      });
      const result = await linux.run([
        "sh",
        "-c",
        "echo disk > /data/object && echo mount > /work/object",
      ]);
      assert.equal(result.status.success, true, new TextDecoder().decode(result.stderr));
    }
    assert.equal(await readFile(join(shared, "object"), "utf8"), "mount\n");
    await using reader = await Linux.create({
      image: rootImage(),
      disks: [{ source: bytes, path: "/data", readOnly: true }],
    });
    assert.equal(await reader.fs.readTextFile("/data/object"), "disk\n");
  });

  it("connects into a guest listener through linux.network", async () => {
    // A network without adapters: nothing leaves it, but the host gets in.
    using network = createNetwork();
    await using linux = await Linux.create({ image: rootImage(), network });
    assert.equal(linux.network?.address, "192.0.2.2");
    // With its stdin at EOF, nc exits once the host closes.
    const server = await linux.spawn(["sh", "-c", "nc -l -p 8080 </dev/null"]);
    const received = new Response(server.stdout).text();
    let connection;
    for (let attempt = 0; ; attempt++) {
      try {
        connection = await linux.network!.connect({ port: 8080 });
        break;
      } catch (error) {
        if (attempt === 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const writer = connection.writable.getWriter();
    await writer.write(new TextEncoder().encode("from the host\n"));
    await writer.close();
    assert.equal(await received, "from the host\n");
  });

  it("leaves the caller's network untouched when the machine cannot boot", async () => {
    using network = createNetwork({
      connectTcp: () => Promise.reject(new Error("unused")),
      resolveDns: () => Promise.resolve([]),
    });
    await assert.rejects(
      Linux.create({ image: join(scratch.path, "missing.erofs"), network }),
      /ENOENT/,
    );
    await assert.rejects(
      network.connect({ hostname: "192.0.2.2", port: 1, transport: "udp" }),
      /not attached/,
    );
  });

  it("mounts a disk without telling it apart from a root image", async () => {
    const root = await readFile(await ext4_root(scratch.path));
    await using linux = await Linux.create({
      image: rootImage(),
      disks: [{ source: root, path: "/data" }],
    });
    await linux.fs.stat("/data/bin/busybox");
  });
});
