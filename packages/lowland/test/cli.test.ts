// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseBuildArgs } from "../src/build.ts";
import { SystemError } from "@lowland/guest";
import type { Linux } from "../src/linux.ts";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { execute, exitCode, parseRunArgs, socket_readable } from "../src/run.ts";
import { UsageError } from "../src/usage.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function lowland(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

describe("lowland", () => {
  it("prints usage with --help", () => {
    const result = lowland("--help");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage: lowland <command>/);
    assert.match(result.stdout, /^ {2}run /m);
    assert.match(result.stdout, /^ {2}build /m);
  });

  it("prints the version", () => {
    const result = lowland("--version");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${version}\n`);
  });

  it("fails without a command", () => {
    const result = lowland();
    assert.equal(result.status, 125);
    assert.match(result.stderr, /^Usage: lowland <command>/);
  });

  it("reports run argument errors with status 125", () => {
    const result = lowland("run", "--disk", "x");
    assert.equal(result.status, 125);
    assert.match(
      result.stderr,
      /^lowland run: --disk expects path:guest\[:ro\], got x\n\nUsage: lowland run/,
    );
  });

  it("rejects unknown commands", () => {
    const result = lowland("image");
    assert.equal(result.status, 125);
    assert.match(result.stderr, /^lowland: unknown command image\n/);
  });

  it("does not treat prototype keys as commands", () => {
    assert.equal(lowland("constructor").status, 125);
  });
});

describe("lowland build", () => {
  it("prints usage with --help", () => {
    const result = lowland("build", "--help");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage: lowland build/);
  });

  it("reports argument errors with its usage and status 125", () => {
    const result = lowland("build", "-p", "busybox");
    assert.equal(result.status, 125);
    assert.match(result.stderr, /^lowland build: missing --output\n\nUsage: lowland build/);
  });

  it("reports build errors without usage and with status 125", () => {
    const result = lowland("build", "-p", "busybox", "--format", "xfs", "-o", "out.img");
    assert.equal(result.status, 125);
    assert.equal(
      result.stderr,
      'lowland build: unsupported image format "xfs", expected one of: erofs, ext4\n',
    );
  });

  it("maps flags to buildImage() options", () => {
    assert.deepEqual(
      parseBuildArgs([
        "-p",
        "busybox",
        "--package",
        "./jq.apk",
        "-f",
        "./app:/usr/bin/app:0755",
        "--file",
        "C:/motd:/etc/motd",
        "-l",
        "/usr/bin/hi=/usr/bin/app",
        "--format",
        "ext4",
        "--compression",
        "none",
        "--label",
        "DATA",
        "--size",
        "64M",
        "-o",
        "app.ext4",
      ]),
      {
        packages: ["busybox", "./jq.apk"],
        files: {
          "/usr/bin/app": { source: "./app", mode: "0755" },
          "/etc/motd": "C:/motd",
        },
        links: { "/usr/bin/hi": "/usr/bin/app" },
        format: "ext4",
        compression: "none",
        label: "DATA",
        size: "64M",
        output: "app.ext4",
      },
    );
  });

  it("returns undefined for --help", () => {
    assert.equal(parseBuildArgs(["--help"]), undefined);
  });

  for (const [args, message] of [
    [["-f", "./app", "-o", "x"], /^--file expects host:guest\[:mode\], got \.\/app$/],
    [["-l", "/a", "-o", "x"], /^--link expects guest=target, got \/a$/],
    [["-l", "=b", "-o", "x"], /^--link expects guest=target/],
    [["extra", "-o", "x"], /Unexpected argument 'extra'/],
    [["--bogus", "-o", "x"], /Unknown option '--bogus'/],
  ] as const) {
    it(`rejects ${args.join(" ")}`, () => {
      assert.throws(
        () => parseBuildArgs(args),
        (error) => error instanceof UsageError && message.test(error.message),
      );
    });
  }
});

describe("lowland run arguments", () => {
  it("ends options at the first word of the command", () => {
    assert.deepEqual(
      parseRunArgs(
        [
          "--image",
          "app.erofs",
          "--disk",
          "C:/data.ext4:/data:ro",
          "--mount",
          "./src:/work",
          "-v",
          "/tmp:/scratch:ro",
          "--cwd",
          "/work",
          "--cpus",
          "2",
          "--network",
          "host",
          "-e",
          "A=1",
          "--env",
          "HOME",
          "--env",
          "UNSET",
          "ls",
          "-l",
          "--env",
        ],
        { HOME: "/home/me" },
      ),
      {
        image: "app.erofs",
        disks: [{ source: "C:/data.ext4", path: "/data", readOnly: true }],
        mounts: [
          { source: "./src", path: "/work", readOnly: false },
          { source: "/tmp", path: "/scratch", readOnly: true },
        ],
        cpus: 2,
        network: "host",
        command: ["ls", "-l", "--env"],
        cwd: "/work",
        env: { A: "1", HOME: "/home/me" },
      },
    );
  });

  it("defaults to / with no network and takes -w for --cwd", () => {
    assert.deepEqual(parseRunArgs(["true"], {}), {
      image: undefined,
      disks: [],
      mounts: [],
      cpus: undefined,
      network: "none",
      command: ["true"],
      cwd: "/",
      env: {},
    });
    assert.equal(parseRunArgs(["-w", "/srv", "pwd"], {})?.cwd, "/srv");
  });

  it("ends options at --", () => {
    assert.deepEqual(parseRunArgs(["--", "--help"])?.command, ["--help"]);
    assert.deepEqual(parseRunArgs([])?.command, []);
  });

  it("returns undefined for --help", () => {
    assert.equal(parseRunArgs(["--help", "ls"]), undefined);
  });

  for (const [args, message] of [
    [["--disk", "data.ext4"], /^--disk expects path:guest\[:ro\], got data\.ext4$/],
    [["--mount", "./src"], /^--mount expects host:guest\[:ro\], got \.\/src$/],
    [["--env", "1A=b"], /^--env expects name\[=value\], got 1A=b$/],
    [["--cpus", "0"], /^--cpus expects a positive whole number, got 0$/],
    [["--cpus", "1.5"], /^--cpus expects a positive whole number, got 1\.5$/],
    [["--network", "bridge"], /^--network expects none or host, got bridge$/],
    [["--image"], /argument missing/],
    [["--bogus"], /Unknown option '--bogus'/],
  ] as const) {
    it(`rejects ${args.join(" ")}`, () => {
      assert.throws(
        () => parseRunArgs(args, {}),
        (error) => error instanceof UsageError && message.test(error.message),
      );
    });
  }

  it("maps statuses to shell exit codes", () => {
    assert.equal(exitCode({ success: true, code: 0, signal: null }), 0);
    assert.equal(exitCode({ success: false, code: 7, signal: null }), 7);
    assert.equal(exitCode({ success: false, code: 0, signal: "SIGKILL" }), 137);
    assert.equal(exitCode({ success: false, code: 0, signal: 6 }), 134);
  });
});

describe("lowland run failures", () => {
  // A stand-in machine whose command is missing and whose disposal fails.
  function failing_machine(dispose: () => Promise<void>) {
    return async () =>
      ({
        spawn: () => Promise.reject(new SystemError(2)),
        [Symbol.asyncDispose]: dispose,
      }) as unknown as Linux;
  }

  it("exits 125 when disposal fails, even after the command ran", async (t) => {
    const stderr = t.mock.method(process.stderr, "write", () => true);
    const code = await execute(
      parseRunArgs(["missing"], {})!,
      ["missing"],
      failing_machine(() => Promise.reject(new Error("could not flush the disks"))),
    );
    assert.equal(code, 125);
    assert.deepEqual(
      stderr.mock.calls.map((call) => call.arguments[0]),
      ["lowland run: missing: command not found\n", "lowland run: could not flush the disks\n"],
    );
  });

  it("keeps the command's status when disposal succeeds", async (t) => {
    t.mock.method(process.stderr, "write", () => true);
    const code = await execute(
      parseRunArgs(["missing"], {})!,
      ["missing"],
      failing_machine(() => Promise.resolve()),
    );
    assert.equal(code, 127);
  });
});

describe("lowland run host network", () => {
  it("ignores a socket's events once its stream is cancelled", async () => {
    const server = createServer((socket) => socket.on("error", () => {}).end("data"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const socket = connect((server.address() as { port: number }).port, "127.0.0.1");
      await once(socket, "connect");
      // A failed destination cancels the stream and destroys the socket;
      // its close event must not close the cancelled stream.
      const closed = once(socket, "close");
      await socket_readable(socket).cancel();
      await closed;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(socket.destroyed, true);
    } finally {
      server.close();
    }
  });
});
