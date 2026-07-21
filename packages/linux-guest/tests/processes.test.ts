import assert from "node:assert/strict";
import { blockDevice, spawnMachine, vsockDevice } from "@tombl/linux";
import { O } from "../src/abi.ts";
import { GuestSession } from "../src/conn.ts";
import { SystemError } from "../src/index.ts";
import { getpid, kill, openat, read, reap, spawn } from "../src/syscalls.ts";
import { assets } from "./assets.ts";
import { guest_test } from "./fixture.ts";
import { collect, pattern_bytes } from "./helpers.ts";

guest_test("processes", async (t, fixture) => {
  const guest = await fixture.spawn();
  const directory = "/workspace/processes";
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

guest_test("session teardown", async (t) => {
  await t.test("cleans resources before accepting a fresh session", async () => {
    const vsock = vsockDevice();
    const root = blockDevice({
      capacity: assets.rootfs.byteLength,
      read(offset, length) {
        return assets.rootfs.subarray(offset, offset + length);
      },
    });
    const machine = await spawnMachine({
      devices: [root, vsock],
      initcpio: assets.initramfs,
    });
    try {
      let first: GuestSession | undefined;
      const deadline = Date.now() + 30_000;
      while (!first) {
        try {
          first = await GuestSession.connect(vsock, { timeoutMs: 1000 });
        } catch (error) {
          if (Date.now() >= deadline) throw error;
        }
      }

      const fifoPath = "/workspace/session-teardown-fifo";
      const created = await spawn(first, ["mkfifo", fifoPath], "/workspace", [
        "PATH=/bin:/usr/bin:/sbin:/usr/sbin",
      ]);
      await created.stdin.close();
      assert.equal(await reap(first, created.pid), 0);
      await Promise.all([created.stdout.close(), created.stderr.close()]);

      const abandoned = await openat(first, "/workspace", O.RDONLY, 0);
      const child = await spawn(
        first,
        ["sh", "-c", "sleep 30 </dev/null >/dev/null 2>&1 & echo $!"],
        "/workspace",
        ["PATH=/bin:/usr/bin:/sbin:/usr/sbin"],
      );
      await child.stdin.close();
      const orphanPid = Number(new TextDecoder().decode(await read(child.stdout, 64)).trim());
      await reap(first, child.pid);
      await Promise.all([child.stdout.close(), child.stderr.close()]);

      const blocked = openat(first, fifoPath, O.RDONLY, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok((await getpid(first)) > 1);
      first.close();
      await assert.rejects(blocked);

      const second = await GuestSession.connect(vsock);
      try {
        const replacement = await openat(second, "/workspace", O.RDONLY, 0);
        // Lane sockets also consume descriptors, so their exact allocation
        // order may differ. Re-entering the old descriptor range proves the
        // abandoned session-owned file was closed.
        assert.ok(replacement.fd <= abandoned.fd);
        await replacement.close();
        await assert.rejects(kill(second, orphanPid, 0), (error) => {
          return error instanceof SystemError && error.code === "ESRCH";
        });
      } finally {
        second.close();
      }
    } finally {
      machine.close();
      await machine.closed;
    }
  });
});
