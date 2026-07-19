import assert from "node:assert/strict";
import { SystemError } from "../src/index.ts";
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

    await t.test("aborts processes", async () => {
      const abort_controller = new AbortController();
      const aborted = await guest.exec(["sleep", "30"], {
        signal: abort_controller.signal,
      });
      const abort_reason = new Error("cancel process");
      abort_controller.abort(abort_reason);
      await assert.rejects(aborted.status, (error) => error === abort_reason);
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
