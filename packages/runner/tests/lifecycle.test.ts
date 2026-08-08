import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function required_environment(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}

const runner = required_environment("LINUX_RUNNER_TEST_RUNNER");
const disk = required_environment("LINUX_RUNNER_TEST_LIFECYCLE_DISK");

interface RunnerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  millisecondsAfterTrigger: number | undefined;
}

async function run_runner(cmdline: string, cpus = 1): Promise<RunnerResult> {
  const child = spawn(runner, ["--disk", disk, "--cpus", cpus.toString(), "--cmdline", cmdline], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let triggeredAt: number | undefined;
  const consume = (chunk: Buffer) => {
    output += chunk.toString();
    if (triggeredAt === undefined && output.includes("lifecycle: triggering panic")) {
      triggeredAt = performance.now();
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  return await new Promise<RunnerResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        output,
        millisecondsAfterTrigger:
          triggeredAt === undefined ? undefined : performance.now() - triggeredAt,
      });
    });
  });
}

test("runner follows the guest lifecycle", async (t) => {
  await t.test("PID 1 exit is a visible nonzero panic", async () => {
    const result = await run_runner("lifecycle=pid1-exit");
    assert.equal(result.signal, null);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Attempted to kill init/);
    assert.match(result.output, /Kernel panic - not syncing/);
  });

  await t.test("explicit panic is visible and nonzero", async () => {
    const result = await run_runner("lifecycle=panic");
    assert.equal(result.signal, null);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Kernel panic - not syncing/);
  });

  await t.test("poweroff is clean", async () => {
    const result = await run_runner("lifecycle=poweroff");
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
  });

  await t.test("panic closes a multi-CPU machine", async () => {
    const result = await run_runner("lifecycle=multi-cpu-panic", 4);
    assert.equal(result.signal, null);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Kernel panic - not syncing/);
  });

  await t.test("panic bypasses a nonzero panic timeout", async () => {
    const result = await run_runner("panic=5 lifecycle=panic");
    assert.equal(result.signal, null);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Kernel panic - not syncing/);
    assert(
      result.millisecondsAfterTrigger !== undefined && result.millisecondsAfterTrigger < 4_000,
      `termination took ${result.millisecondsAfterTrigger}ms after the panic trigger`,
    );
  });
});
