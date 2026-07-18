import assert from "node:assert/strict";
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

    await t.test("aborts processes", async () => {
      const abort_controller = new AbortController();
      const aborted = await guest.exec(["sleep", "30"], {
        signal: abort_controller.signal,
      });
      const abort_reason = new Error("cancel process");
      abort_controller.abort(abort_reason);
      await assert.rejects(aborted.status, (error) => error === abort_reason);
    });

    await t.test("allows commands to orphan child processes", async () => {
      const orphaned = await guest.exec([
        "sh",
        "-c",
        "sh -c 'i=0; while [ $i -lt 1000 ]; do i=$((i + 1)); done' &",
      ]);
      assert.deepEqual(await orphaned.status, {
        success: true,
        code: 0,
        signal: null,
      });
    });

    await t.test("reaps orphaned processes", async () => {
      const zombie_check = await guest.exec([
        "sh",
        "-c",
        'for stat in /proc/[0-9]*/stat; do case "$(cat "$stat")" in *") Z 1 "*) exit 1;; esac; done',
      ]);
      assert.deepEqual(await zombie_check.status, {
        success: true,
        code: 0,
        signal: null,
      });
    });
  } finally {
    await guest.fs.remove(directory, { recursive: true });
  }
});
