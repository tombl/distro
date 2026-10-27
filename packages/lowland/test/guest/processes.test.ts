import assert from "node:assert/strict";
import { bootConsole, bootMachine, vsockDevice } from "../../src/machine/index.ts";
import type { MachinePlugin } from "../../src/machine/plugin.ts";
import { test } from "node:test";
import { O } from "../../src/guest/abi.ts";
import { GuestSession } from "../../src/guest/conn.ts";
import { guestAgent, SeekMode, SystemError, type GuestAgent } from "../../src/guest/index.ts";
import { spawn_stdio, spawn_terminal } from "../../src/guest/process.ts";
import {
  type FileAction,
  getpid,
  kill,
  mkdirat,
  mount,
  openat,
  read,
  reap,
  spawn,
  SPAWN,
  write,
} from "../../src/guest/syscalls.ts";
import { agent_initramfs, busybox_initramfs, root_mount } from "./assets.ts";
import { guest_test } from "./fixture.ts";
import { collect, console_output, pattern_bytes } from "./helpers.ts";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const succeeded = { success: true, code: 0, signal: null };

// Fails rather than hangs if `promise` does not settle in time.
async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function assert_missing_program(guest: GuestAgent) {
  const missing = (error: unknown) => error instanceof SystemError && error.code === "ENOENT";
  await assert.rejects(guest.exec(["no-such-program"]), missing);
  await assert.rejects(guest.run(["no-such-program"]), missing);
}

guest_test("processes", async (t, fixture) => {
  const guest = await fixture.spawn();
  const directory = "/tmp/processes";
  await guest.fs.mkdir(directory);
  try {
    const large = pattern_bytes(256 * 1024);
    await guest.fs.writeFile(`${directory}/large.bin`, large);
    await t.test("streams stdio and configures the environment", async () => {
      const child = await guest.exec(["sh", "-c", 'cat; printf \'%s:%s\' "$GREETING" "$PWD" >&2'], {
        cwd: directory,
        env: { GREETING: "hello" },
      });
      const output = collect(child.stdout);
      const error = collect(child.stderr);
      const status = child.status;
      const stdin = child.stdin.getWriter();
      await stdin.write(large);
      await stdin.close();
      const [stdout, stderr, result] = await Promise.all([output, error, status]);
      assert.deepEqual(stdout, large);
      assert.equal(new TextDecoder().decode(stderr), `hello:${directory}`);
      assert.deepEqual(result, { success: true, code: 0, signal: null });
    });

    await t.test("runs processes concurrently with filesystem traffic", async () => {
      const concurrent = await Promise.all([guest.exec(["cat"]), guest.exec(["cat"])]);
      const collected = concurrent.map((process) => ({
        output: collect(process.stdout),
        error: collect(process.stderr),
        status: process.status,
      }));
      assert.equal((await guest.fs.stat(`${directory}/large.bin`)).size, large.byteLength);
      await Promise.all(
        concurrent.map(async (process, index) => {
          const writer = process.stdin.getWriter();
          await writer.write(large.subarray(index * 32 * 1024, (index + 1) * 32 * 1024));
          await writer.close();
        }),
      );
      for (const [index, { output, error, status }] of collected.entries()) {
        assert.deepEqual(await output, large.subarray(index * 32 * 1024, (index + 1) * 32 * 1024));
        assert.equal((await error).byteLength, 0);
        assert.deepEqual(await status, { success: true, code: 0, signal: null });
      }
    });

    await t.test("kills processes with signals", async () => {
      const signalled = await guest.exec(["sleep", "30"]);
      await signalled.kill("SIGTERM");
      assert.deepEqual(await signalled.status, {
        success: false,
        code: 0,
        signal: "SIGTERM",
      });
    });

    await t.test("reports fatal process signals", async () => {
      const crashed = await guest.exec(["sh", "-c", "kill -SEGV $$"]);
      assert.deepEqual(await crashed.status, {
        success: false,
        code: 0,
        signal: 11,
      });
    });

    await t.test("isolates user module traps to the offending process", async () => {
      const survivor = await guest.exec(["cat"]);
      const survivor_output = collect(survivor.stdout);
      const crashed = await guest.exec(["/tmp/user-trap"]);
      assert.deepEqual(await crashed.status, {
        success: false,
        code: 0,
        signal: 11,
      });

      const input = survivor.stdin.getWriter();
      await input.write(new TextEncoder().encode("still running\n"));
      await input.close();
      assert.equal(new TextDecoder().decode(await survivor_output), "still running\n");
      assert.deepEqual(await survivor.status, {
        success: true,
        code: 0,
        signal: null,
      });

      const after = await guest.exec(["true"]);
      assert.deepEqual(await after.status, {
        success: true,
        code: 0,
        signal: null,
      });
    });

    await t.test("reports explicit exit statuses", async () => {
      const exited = await guest.exec(["sh", "-c", "exit 37"]);
      assert.deepEqual(await exited.status, {
        success: false,
        code: 37,
        signal: null,
      });
    });

    await t.test("resolves commands from the supplied PATH and cwd", async () => {
      const bin = `${directory}/custom-bin`;
      await guest.fs.mkdir(bin);
      const command = `${bin}/path-command`;
      await guest.fs.writeTextFile(command, '#!/bin/sh\nprintf \'%s:%s\' "$PATH" "$PWD"\n');
      await guest.fs.chmod(command, 0o755);

      const child = await guest.exec(["path-command"], {
        cwd: directory,
        env: { PATH: "custom-bin" },
      });
      const output = collect(child.stdout);
      await child.stdin.getWriter().close();
      assert.deepEqual(await child.status, {
        success: true,
        code: 0,
        signal: null,
      });
      assert.equal(new TextDecoder().decode(await output), `custom-bin:${directory}`);
    });

    await t.test("rejects missing programs", () => assert_missing_program(guest));

    await t.test("aborts processes", async () => {
      const abort_controller = new AbortController();
      const aborted = await guest.exec(["sleep", "30"], {
        signal: abort_controller.signal,
      });
      const abort_reason = new Error("cancel process");
      abort_controller.abort(abort_reason);
      await assert.rejects(aborted.status, (error) => error === abort_reason);
    });

    await t.test("settles buffered stdin before its descriptor is reused", async () => {
      // The short-lived background process keeps the old stdin pipe open
      // after close kills the tracked process, holding one injected write in
      // flight long enough for a subsequent spawn to reuse its numeric fd.
      const stopped = await guest.exec(["sh", "-c", "sleep 0.2 <&0 & exec sleep 30"]);
      const input = stopped.stdin.getWriter();
      for (let offset = 0; offset < large.byteLength; offset += 32 * 1024) {
        await input.write(large.subarray(offset, offset + 32 * 1024));
      }
      await stopped.close();

      const replacement = await guest.exec(["cat"]);
      const output = collect(replacement.stdout);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await replacement.stdin.getWriter().close();
      assert.deepEqual(await output, new Uint8Array());
      assert.deepEqual(await replacement.status, {
        success: true,
        code: 0,
        signal: null,
      });
    });

    await t.test("connects standard descriptors to /dev/null", async () => {
      const child = await guest.exec(["sleep", "30"], { stdio: ["null", "null", "pipe"] });
      try {
        assert.equal(await guest.fs.readLink(`/proc/${child.pid}/fd/0`), "/dev/null");
        assert.equal(await guest.fs.readLink(`/proc/${child.pid}/fd/1`), "/dev/null");
        assert.equal((await collect(child.stdout)).byteLength, 0);
        await assert.rejects(child.stdin.getWriter().write(new Uint8Array(1)), TypeError);
      } finally {
        await child.close();
      }
      // Input ends at once and output is discarded. run() closes stdin, which
      // is fine with no pipe behind it.
      const result = await guest.run(["sh", "-c", "cat; echo lost; echo kept >&2"], {
        stdio: ["null", "null", "pipe"],
      });
      assert.deepEqual(result.status, succeeded);
      assert.equal(result.stdout.byteLength, 0);
      assert.equal(decode(result.stderr), "kept\n");
    });

    await t.test("sends standard error to standard output", async () => {
      const result = await guest.run(["sh", "-c", "echo out; echo err >&2; echo out"], {
        stdio: ["pipe", "pipe", "stdout"],
      });
      assert.deepEqual(result.status, succeeded);
      assert.equal(decode(result.stdout), "out\nerr\nout\n");
      assert.equal(result.stderr.byteLength, 0);
    });

    await t.test("reads standard input from a guest file", async () => {
      const path = `${directory}/input.txt`;
      await guest.fs.writeTextFile(path, "one\ntwo\n");
      await using input = await guest.fs.open(path);
      const result = await guest.run(["cat"], { stdio: [input, "pipe", "pipe"] });
      assert.deepEqual(result.status, succeeded);
      assert.equal(decode(result.stdout), "one\ntwo\n");
      // The process shared the file's offset.
      assert.equal(await input.seek(0, SeekMode.Current), 8);
    });

    await t.test("writes standard output to a guest file", async () => {
      const path = `${directory}/output.txt`;
      {
        await using output = await guest.fs.open(path, { write: true, create: true });
        const result = await guest.run(["sh", "-c", "echo out; echo err >&2"], {
          stdio: ["null", output, "stdout"],
        });
        assert.deepEqual(result, {
          status: succeeded,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        });
      }
      assert.equal(await guest.fs.readTextFile(path), "out\nerr\n");
    });

    await t.test("spawns concurrently on crossed guest files", async () => {
      // Each spawn holds its files only until the agent replies, whatever
      // their order, so crossing them cannot deadlock either the spawns or
      // the files' close.
      const a = await guest.fs.open(`${directory}/a.txt`, { write: true, create: true });
      const b = await guest.fs.open(`${directory}/b.txt`, { write: true, create: true });
      const results = await within(
        10_000,
        Promise.all([
          guest.run(["sh", "-c", "echo 1; echo 2 >&2"], { stdio: ["null", a, b] }),
          guest.run(["sh", "-c", "echo 3; echo 4 >&2"], { stdio: ["null", b, a] }),
        ]),
      );
      await within(10_000, Promise.all([a.close(), b.close()]));
      assert.deepEqual(
        results.map((result) => result.status),
        [succeeded, succeeded],
      );
      const lines = async (path: string) => (await guest.fs.readTextFile(path)).split("\n").sort();
      assert.deepEqual(await lines(`${directory}/a.txt`), ["", "1", "4"]);
      assert.deepEqual(await lines(`${directory}/b.txt`), ["", "2", "3"]);
    });

    await t.test("passes a process only its standard descriptors", async () => {
      // Open files, pipes, and lanes are all close-on-exec on the agent's
      // side, so ls sees fds 0-2 and the directory it opened.
      await using held = await guest.fs.open(`${directory}/large.bin`);
      const result = await guest.run(["ls", "/proc/self/fd"], { stdio: [held, "pipe", "pipe"] });
      assert.equal(decode(result.stdout), "0\n1\n2\n3\n");
    });

    await t.test("rejects invalid stdio before spawning", async () => {
      const closed = await guest.fs.open(`${directory}/large.bin`);
      await closed.close();
      for (const options of [
        { terminal: true, stdio: ["pipe", "pipe", "pipe"] },
        { stdio: ["stdout", "pipe", "pipe"] },
        { stdio: ["pipe", "pipe"] },
        { stdio: ["pipe", "pipe", "file"] },
        { stdio: [closed, "pipe", "pipe"] },
      ]) {
        await assert.rejects(guest.exec(["true"], options as never), TypeError);
      }
      assert.deepEqual((await guest.run(["true"])).status, succeeded);
    });

    await t.test("reaps adopted orphan processes", async () => {
      const pid_file = `${directory}/orphan.pid`;
      const orphaned = await guest.exec([
        "sh",
        "-c",
        `sh -c 'sleep 0.1' & echo $! > "${pid_file}"`,
      ]);
      assert.deepEqual(await orphaned.status, {
        success: true,
        code: 0,
        signal: null,
      });

      const orphan_pid = new TextDecoder().decode(await guest.fs.readFile(pid_file)).trim();
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          await guest.fs.stat(`/proc/${orphan_pid}`);
        } catch (error) {
          if (error instanceof SystemError && error.code === "ENOENT") break;
          throw error;
        }
        if (Date.now() >= deadline) assert.fail(`orphan ${orphan_pid} was not reaped`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
  } finally {
    await guest.fs.remove(directory, { recursive: true });
  }
});

// Without a console the kernel starts the agent with no stdio descriptors, so
// child stdio pipes must not be allocated in their place.
test("guest without a console", async (t) => {
  const guest = guestAgent({ mounts: [root_mount()] });
  const machine = await bootMachine({
    cpus: 1,
    plugins: [bootConsole(console_output()), guest],
  });
  try {
    await t.test("streams stdin, stdout, and stderr separately", async () => {
      const child = await guest.exec(["sh", "-c", "cat; printf error >&2"]);
      const output = collect(child.stdout);
      const error = collect(child.stderr);
      const stdin = child.stdin.getWriter();
      await stdin.write(new TextEncoder().encode("input"));
      await stdin.close();
      const [stdout, stderr, status] = await Promise.all([output, error, child.status]);
      assert.equal(new TextDecoder().decode(stdout), "input");
      assert.equal(new TextDecoder().decode(stderr), "error");
      assert.deepEqual(status, { success: true, code: 0, signal: null });
    });

    await t.test("collects successful runs", async () => {
      const result = await guest.run(["sh", "-c", "printf output; printf error >&2"]);
      assert.deepEqual(result.status, { success: true, code: 0, signal: null });
      assert.equal(new TextDecoder().decode(result.stdout), "output");
      assert.equal(new TextDecoder().decode(result.stderr), "error");
    });

    await t.test("rejects missing programs", () => assert_missing_program(guest));
  } finally {
    machine.kill();
    await machine.exited;
  }
});

// The agent alone on an initramfs with BusyBox, driven over raw sessions:
// no boot, no switch_root.
async function boot_agent_alone() {
  const vsock = vsockDevice();
  const agent_only: MachinePlugin = {
    configure(setup) {
      setup.devices.add(vsock);
      setup.initramfs.add(busybox_initramfs);
      setup.initramfs.add(agent_initramfs);
    },
  };
  const machine = await bootMachine({ cpus: 1, plugins: [agent_only] });
  const connect = async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        return await GuestSession.connect(vsock, { timeoutMs: 1000 });
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
    }
  };
  return { vsock, machine, connect };
}

guest_test("session teardown", async (t) => {
  await t.test("cleans resources before accepting a fresh session", async () => {
    const { vsock, machine, connect } = await boot_agent_alone();
    try {
      const first = await connect();

      // Terminals need devpts, which only a boot would have mounted.
      await mkdirat(first, "/dev/pts", 0o755);
      await mount(first, "devpts", "/dev/pts", "devpts", 0, null);

      const env = ["PATH=/bin:/usr/bin:/sbin:/usr/sbin"];
      // Runs a command with its output on a pipe and no input, and returns
      // its pid and output once it exits.
      const run = async (argv: string[]) => {
        const child = await spawn_stdio(first, argv, "/tmp", env, ["null", "pipe", "null"]);
        const output = new TextDecoder().decode(await read(child.stdout!, 64));
        const status = await reap(first, child.pid);
        await child.stdout!.close();
        return { status, output };
      };

      const fifoPath = "/tmp/session-teardown-fifo";
      assert.equal((await run(["mkfifo", fifoPath])).status, 0);

      const abandoned = await openat(first, "/tmp", O.RDONLY, 0);
      const { output: orphan } = await run([
        "sh",
        "-c",
        "sleep 30 </dev/null >/dev/null 2>&1 & echo $!",
      ]);
      const orphanPid = Number(orphan.trim());

      // Processes outside the session's process group: one that started its
      // own session, and a terminal process, which always leads one.
      const { output: escaped } = await run([
        "sh",
        "-c",
        "setsid sleep 30 </dev/null >/dev/null 2>&1 & echo $!",
      ]);
      const escapedPid = Number(escaped.trim());
      const terminal = await spawn_terminal(first, ["sleep", "30"], "/tmp", env, {
        rows: 24,
        columns: 80,
      });

      const blocked = openat(first, fifoPath, O.RDONLY, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok((await getpid(first)) > 1);
      first.close();
      await assert.rejects(blocked);

      const second = await GuestSession.connect(vsock);
      try {
        const replacement = await openat(second, "/tmp", O.RDONLY, 0);
        // Lane sockets also consume descriptors, so their exact allocation
        // order may differ. Re-entering the old descriptor range proves the
        // abandoned session-owned file was closed.
        assert.ok(replacement.fd <= abandoned.fd);
        await replacement.close();
        for (const pid of [orphanPid, escapedPid, terminal.pid]) {
          await assert.rejects(kill(second, pid, 0), (error) => {
            return error instanceof SystemError && error.code === "ESRCH";
          });
        }
      } finally {
        second.close();
      }
    } finally {
      machine.kill();
      await machine.exited;
    }
  });
});

test("agent protocol", async (t) => {
  const { vsock, machine, connect } = await boot_agent_alone();
  try {
    await t.test("echoes only its own protocol version", async () => {
      const hello = (version: number) => {
        const bytes = new Uint8Array(8);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, 0x584e4c54, true);
        view.setUint16(4, version, true);
        return bytes;
      };
      // Connecting a session first waits until the agent listens.
      (await connect()).close();
      const old = await vsock.connect(1024);
      try {
        await old.write(hello(5));
        assert.ok((await old.readExactly(8)).byteLength < 8, "the agent echoed version 5");
      } finally {
        old.close();
      }
      const current = await vsock.connect(1024);
      try {
        await current.write(hello(6));
        assert.deepEqual(await current.readExactly(8), hello(6));
      } finally {
        current.close();
      }
    });

    await t.test("validates file actions", async () => {
      const session = await connect();
      try {
        const sh = (script: string, actions: FileAction[], flags: number = SPAWN.SETSIGDEF) =>
          spawn(session, ["/bin/sh", "-c", script], "/", ["PATH=/bin"], flags, actions);
        const fails = (code: string) => (error: unknown) =>
          error instanceof SystemError && error.code === code;
        const dev_null = (newfd: number): FileAction => ({
          op: "open",
          path: "/dev/null",
          oflag: O.RDWR,
          newfd,
        });

        // Descriptors that are not open, or cannot be.
        await assert.rejects(sh(":", [{ op: "dup2", fd: 1000, newfd: 0 }]), fails("EBADF"));
        await assert.rejects(sh(":", [{ op: "dup2", fd: -1, newfd: 0 }]), fails("EBADF"));
        await assert.rejects(sh(":", [{ op: "close", fd: -1 }]), fails("EBADF"));
        // Wherever it is in the list, as long as the list parses.
        const bad: FileAction = { op: "dup2", fd: -1, newfd: 0 };
        const fine: FileAction = { op: "close", fd: 9 };
        await assert.rejects(sh(":", [bad, fine]), fails("EBADF"));
        await assert.rejects(sh(":", [fine, bad, fine]), fails("EBADF"));
        await assert.rejects(sh(":", [bad, { op: "chdir" } as never]), fails("EINVAL"));
        // A path that does not exist reads like a missing program, also when
        // PATH is searched, and paths the agent cannot parse.
        const missing: FileAction = { op: "open", path: "/no/such", oflag: O.RDONLY, newfd: 0 };
        await assert.rejects(sh(":", [missing]), fails("ENOENT"));
        await assert.rejects(
          spawn(session, ["true"], "/", ["PATH=/bin"], SPAWN.SETSIGDEF, [missing]),
          fails("ENOENT"),
        );
        await assert.rejects(
          sh(":", [{ op: "open", path: "/dev/\0null", oflag: O.RDONLY, newfd: 0 }]),
          fails("EINVAL"),
        );
        await assert.rejects(
          sh(":", [{ op: "open", path: "/".repeat(5000), oflag: O.RDONLY, newfd: 0 }]),
          fails("EINVAL"),
        );
        // Malformed lists and flags.
        await assert.rejects(sh(":", [{ op: "chdir" } as never]), fails("EINVAL"));
        await assert.rejects(
          sh(
            ":",
            Array.from({ length: 65 }, () => ({ op: "close", fd: 9 }) as const),
          ),
          fails("EINVAL"),
        );
        await assert.rejects(sh(":", [], 4), fails("EINVAL"));

        // The lane survives every rejection, and the actions run in order:
        // a closed stdin, and output in a file that stderr shares.
        const pid = await sh("test -e /proc/$$/fd/0 || { echo out; echo err >&2; exit 9; }", [
          { op: "close", fd: 0 },
          {
            op: "open",
            path: "/tmp/actions",
            oflag: O.WRONLY | O.CREAT | O.TRUNC,
            mode: 0o644,
            newfd: 1,
          },
          { op: "dup2", fd: 1, newfd: 2 },
        ]);
        assert.equal(await reap(session, pid), 9 << 8);
        await using written = await openat(session, "/tmp/actions", O.RDONLY, 0);
        assert.equal(new TextDecoder().decode(await read(written, 64)), "out\nerr\n");
        assert.equal(await reap(session, await sh(":", [dev_null(0)])), 0);
      } finally {
        session.close();
      }
    });

    await t.test("runs the file actions once, then searches PATH", async () => {
      const session = await connect();
      try {
        const fails = (code: string) => (error: unknown) =>
          error instanceof SystemError && error.code === code;
        const run_true = async (path: string, actions: FileAction[] = []) => {
          const pid = await spawn(
            session,
            ["true"],
            "/",
            [`PATH=${path}`],
            SPAWN.SETSIGDEF,
            actions,
          );
          return reap(session, pid);
        };
        const create = async (path: string, text: string, mode: number) => {
          await using file = await openat(session, path, O.WRONLY | O.CREAT | O.TRUNC, mode);
          await write(file, new TextEncoder().encode(text));
        };

        // An exclusive create fails if it runs again for /bin after /missing.
        const exclusive: FileAction = {
          op: "open",
          path: "/tmp/exclusive",
          oflag: O.WRONLY | O.CREAT | O.EXCL,
          mode: 0o644,
          newfd: 1,
        };
        assert.equal(await run_true("/missing:/bin", [exclusive]), 0);

        // A script whose interpreter is missing fails with ENOENT, which
        // moves on; one that cannot be executed is remembered as EACCES.
        await mkdirat(session, "/tmp/broken", 0o755);
        await create("/tmp/broken/true", "#!/no/such/interpreter\n", 0o755);
        assert.equal(await run_true("/tmp/broken:/bin"), 0);
        await mkdirat(session, "/tmp/unexecutable", 0o755);
        await create("/tmp/unexecutable/true", "", 0o644);
        await assert.rejects(run_true("/tmp/unexecutable:/missing"), fails("EACCES"));
        await assert.rejects(run_true("/missing:/tmp/broken"), fails("ENOENT"));
      } finally {
        session.close();
      }
    });
  } finally {
    machine.kill();
    await machine.exited;
  }
});

// Without a console device the agent starts with no standard descriptors.
// Pipes must not take their numbers, or spawn errors are misreported.
test("reports failed spawns in a machine without a console", async () => {
  const agent = guestAgent({ mounts: [root_mount()] });
  const machine = await bootMachine({ cpus: 1, plugins: [agent] });
  try {
    for (const [argv, code] of [
      [["/no/such"], "ENOENT"],
      [["no-such-command"], "ENOENT"],
      [["/etc"], "EACCES"],
    ] as const) {
      await assert.rejects(
        agent.exec(argv),
        (error) => error instanceof SystemError && error.code === code,
      );
      const result = await agent.run(["true"]);
      assert.deepEqual(result.status, { success: true, code: 0, signal: null });
    }
  } finally {
    machine.kill();
    await machine.exited;
  }
});
