// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseBuildArgs } from "../src/cli/build.ts";
import { SystemError } from "../src/guest/index.ts";
import type { Linux } from "../src/linux.ts";
import type { MachineExit } from "../src/machine/index.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnOptions, TerminalSize } from "../src/guest/index.ts";
import { execute, parseRunArgs, type HostTerminal } from "../src/cli/run.ts";
import { exitCode } from "../src/guest/index.ts";
import { UsageError } from "../src/cli/usage.ts";

const cli = fileURLToPath(new URL("../src/cli/cli.ts", import.meta.url));
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
    const result = lowland("run", "-v", "x");
    assert.equal(result.status, 125);
    assert.match(
      result.stderr,
      /^lowland run: --volume expects src:\/dst\[:ro\|:rw\|:O\], got x\n\nUsage: lowland run/,
    );
  });

  it("refuses --tty when stdin is not a terminal", () => {
    const result = lowland("run", "-t", "true");
    assert.equal(result.status, 125);
    assert.equal(result.stderr, "lowland run: --tty needs stdin to be a terminal\n");
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
          "-v",
          "C:/data.ext4:/data:ro",
          "--volume",
          "./src:/work",
          "-v",
          "/tmp:/scratch:O",
          "-v",
          "a:b:/rw:rw",
          "--workdir",
          "/work",
          "--cpus",
          "2",
          "--network",
          "nat",
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
        volumes: [
          { source: "app.erofs", path: "/", mode: "overlay" },
          { source: "C:/data.ext4", path: "/data", mode: "ro" },
          { source: "./src", path: "/work", mode: "rw" },
          { source: "/tmp", path: "/scratch", mode: "overlay" },
          { source: "a:b", path: "/rw", mode: "rw" },
        ],
        cpus: 2,
        network: "nat",
        command: ["ls", "-l", "--env"],
        cwd: "/work",
        env: { A: "1", HOME: "/home/me" },
        tty: false,
      },
    );
  });

  it("defaults to / with no network and takes -w for --workdir", () => {
    assert.deepEqual(parseRunArgs(["true"], {}), {
      volumes: [],
      cpus: undefined,
      network: "none",
      command: ["true"],
      cwd: "/",
      env: {},
      tty: false,
    });
    assert.equal(parseRunArgs(["-w", "/srv", "pwd"], {})?.cwd, "/srv");
  });

  it("takes -t for --tty", () => {
    assert.equal(parseRunArgs(["-t", "top"], {})?.tty, true);
    assert.equal(parseRunArgs(["--tty", "-w", "/srv"], {})?.tty, true);
  });

  it("ends options at --", () => {
    assert.deepEqual(parseRunArgs(["--", "--help"])?.command, ["--help"]);
    assert.deepEqual(parseRunArgs([])?.command, []);
  });

  it("returns undefined for --help", () => {
    assert.equal(parseRunArgs(["--help", "ls"]), undefined);
  });

  for (const [args, message] of [
    [["-v", "data.ext4"], /^--volume expects src:\/dst\[:ro\|:rw\|:O\], got data\.ext4$/],
    [["-v", ":/data"], /^--volume expects src:\/dst/],
    [["-v", "./src:work"], /^--volume expects src:\/dst/],
    [["-v", "./src:/work:rx"], /^--volume expects src:\/dst/],
    [["-v", "a:/x", "-v", "b:/x"], /^two volumes at \/x$/],
    [
      ["--image", "a.erofs", "-v", "b.ext4:/"],
      /^--image and a volume at \/ both replace the root$/,
    ],
    [["--image", ""], /^--image expects a path$/],
    [["--disk", "a:/b"], /Unknown option '--disk'/],
    [["--mount", "a:/b"], /Unknown option '--mount'/],
    [["--cwd", "/b"], /Unknown option '--cwd'/],
    [["--env", "1A=b"], /^--env expects name\[=value\], got 1A=b$/],
    [["--cpus", "0"], /^--cpus expects a positive whole number, got 0$/],
    [["--cpus", "1.5"], /^--cpus expects a positive whole number, got 1\.5$/],
    [["--network", "host"], /^--network expects none or nat, got host$/],
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
    assert.equal(exitCode({ success: false, code: null, signal: "SIGKILL" }), 137);
    assert.equal(exitCode({ success: false, code: null, signal: 6 }), 134);
  });
});

describe("lowland run failures", () => {
  // A stand-in machine whose command is missing and which ends as `exit`.
  function failing_machine(exit: MachineExit) {
    const timeouts: (number | undefined)[] = [];
    const create = async () =>
      ({
        spawn: () => Promise.reject(new SystemError(2)),
        shutdown: async (options?: { timeoutMs?: number }) => {
          timeouts.push(options?.timeoutMs);
          return exit;
        },
      }) as unknown as Linux;
    return { create, timeouts };
  }

  for (const [exit, message] of [
    [{ reason: "kill" }, "the machine did not shut down within 10 s, and was killed"],
    [{ reason: "crash", error: new Error("flush failed") }, "flush failed"],
  ] as const) {
    it(`exits 125 when the machine ends with ${exit.reason}, even after the command ran`, async (t) => {
      const stderr = t.mock.method(process.stderr, "write", () => true);
      const { create, timeouts } = failing_machine(exit);
      const code = await execute(parseRunArgs(["missing"], {})!, ["missing"], { create });
      assert.equal(code, 125);
      assert.deepEqual(timeouts, [10_000]);
      assert.deepEqual(
        stderr.mock.calls.map((call) => call.arguments[0]),
        ["lowland run: missing: command not found\n", `lowland run: ${message}\n`],
      );
    });
  }

  it("keeps the command's status when the machine powers off", async (t) => {
    t.mock.method(process.stderr, "write", () => true);
    const { create } = failing_machine({ reason: "poweroff" });
    const code = await execute(parseRunArgs(["missing"], {})!, ["missing"], { create });
    assert.equal(code, 127);
  });
});

describe("lowland run signals", () => {
  it("holds signals until the machine has shut down", async (t) => {
    t.mock.method(process.stderr, "write", () => true);
    const before = process.listenerCount("SIGINT");
    let during = 0;
    const create = async () =>
      ({
        spawn: () => Promise.reject(new SystemError(2)),
        shutdown: async () => {
          // A Ctrl-C now would otherwise end lowland before the disks flush.
          during = process.listenerCount("SIGINT");
          return { reason: "poweroff" };
        },
      }) as unknown as Linux;
    assert.equal(await execute(parseRunArgs(["missing"], {})!, ["missing"], { create }), 127);
    assert.ok(during > before);
    assert.equal(process.listenerCount("SIGINT"), before);
  });

  it("forwards a signal that arrives while the command starts", async () => {
    const kills: string[] = [];
    const status = Promise.withResolvers<{ success: boolean; code: null; signal: "SIGINT" }>();
    const child = {
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      status: status.promise,
      kill: async (signal: string) => {
        kills.push(signal);
        status.resolve({ success: false, code: null, signal: "SIGINT" });
      },
      resize: async () => {},
      [Symbol.asyncDispose]: async () => {},
    };
    const spawned = Promise.withResolvers<void>();
    const create = async () =>
      ({
        spawn: async () => {
          process.emit("SIGINT");
          await spawned.promise;
          return child;
        },
        shutdown: async () => ({ reason: "poweroff" }),
      }) as unknown as Linux;
    const code = execute(parseRunArgs(["sleep", "60"], {})!, ["sleep", "60"], { create });
    await new Promise(setImmediate);
    spawned.resolve();
    assert.equal(await code, 130);
    assert.deepEqual(kills, ["SIGINT"]);
  });

  it("forwards no signal once the command has been reaped", async () => {
    const kills: string[] = [];
    // The command exits, but a descendant holds its output open.
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const status = Promise.withResolvers<{ success: boolean; code: number; signal: null }>();
    const child = {
      stdin: new WritableStream<Uint8Array>(),
      stdout: output.readable,
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      status: status.promise,
      kill: async (signal: string) => void kills.push(signal),
      resize: async () => {},
      [Symbol.asyncDispose]: async () => {},
    };
    const create = async () =>
      ({
        spawn: async () => child,
        shutdown: async () => ({ reason: "poweroff" }),
      }) as unknown as Linux;
    const code = execute(parseRunArgs(["true"], {})!, ["true"], { create });
    await new Promise(setImmediate);
    process.emit("SIGINT");
    status.resolve({ success: true, code: 0, signal: null });
    await new Promise(setImmediate);
    process.emit("SIGINT");
    await output.writable.close();
    assert.equal(await code, 0);
    assert.deepEqual(kills, ["SIGINT"]);
  });
});

describe("lowland run terminals", () => {
  // A stand-in host terminal and a machine whose command, on a guest
  // terminal, fails once the test lets it.
  function setup() {
    const input = Object.assign(new PassThrough(), {
      modes: [] as boolean[],
      setRawMode(mode: boolean) {
        this.modes.push(mode);
        return this;
      },
    });
    const output = Object.assign(new EventEmitter(), { rows: 30, columns: 100 });
    const terminal = { input, output } as unknown as HostTerminal;
    const failure = Promise.withResolvers<never>();
    const resizes: TerminalSize[] = [];
    let spawned: SpawnOptions | undefined;
    const create = async () =>
      ({
        async spawn(_: string[], options: SpawnOptions) {
          spawned = options;
          // The window changes size while the guest terminal is created.
          output.rows = 35;
          return {
            stdin: new WritableStream(),
            stdout: new ReadableStream(),
            stderr: new ReadableStream(),
            status: failure.promise,
            kill: async () => {},
            resize: async (size: TerminalSize) => void resizes.push(size),
          };
        },
        shutdown: async () => ({ reason: "poweroff" }),
      }) as unknown as Linux;
    return { input, output, terminal, failure, resizes, create, spawned: () => spawned };
  }

  it("follows the host terminal and restores it when the machine fails", async (t) => {
    const stderr = t.mock.method(process.stderr, "write", () => true);
    const { input, output, terminal, failure, resizes, create, spawned } = setup();
    const code = execute(parseRunArgs([], { TERM: "xterm-ghostty" })!, ["sh"], {
      terminal,
      create,
    });
    while (!input.modes.length) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(spawned(), {
      cwd: "/",
      env: { TERM: "xterm" },
      terminal: { rows: 30, columns: 100 },
    });
    assert.deepEqual(input.modes, [true]);
    assert.deepEqual(resizes, [{ rows: 35, columns: 100 }]);
    Object.assign(output, { rows: 40, columns: 120 }).emit("resize");
    assert.deepEqual(resizes, [
      { rows: 35, columns: 100 },
      { rows: 40, columns: 120 },
    ]);

    failure.reject(new Error("the machine failed"));
    assert.equal(await code, 125);
    assert.deepEqual(input.modes, [true, false]);
    assert.deepEqual(
      stderr.mock.calls.map((call) => call.arguments[0]),
      ["lowland run: the machine failed\n"],
    );
    assert.equal(output.listenerCount("resize"), 0);
  });

  it("keeps a TERM given with --env", async (t) => {
    t.mock.method(process.stderr, "write", () => true);
    const { input, terminal, failure, create, spawned } = setup();
    const code = execute(parseRunArgs(["-e", "TERM=vt100"], {})!, ["sh"], { terminal, create });
    while (!input.modes.length) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(spawned()?.env, { TERM: "vt100" });
    failure.reject(new Error("done"));
    await code;
  });
});
