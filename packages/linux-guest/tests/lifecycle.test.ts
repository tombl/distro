import { consoleDevice, MachinePanicError, spawnMachine } from "@tombl/linux";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { lifecycle_assets } from "./assets.ts";
import { closed_input } from "./helpers.ts";

function output_sink(output: { text: string }) {
  const decoder = new TextDecoder();
  return new WritableStream<Uint8Array>({
    write(chunk) {
      output.text += decoder.decode(chunk, { stream: true });
    },
    close() {
      output.text += decoder.decode();
    },
  });
}

async function with_timeout<T>(promise: Promise<T>, milliseconds = 30_000) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function run_machine(mode: string) {
  const output = { text: "" };
  const machine = await spawnMachine({
    cmdline: `lifecycle=${mode}`,
    cpus: 1,
    devices: [consoleDevice(closed_input(), output_sink(output))],
    initcpio: lifecycle_assets.initramfs,
  });
  void machine.bootConsole.pipeTo(output_sink(output)).catch(() => {});
  return { machine, output };
}

interface RunnerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  milliseconds_after_trigger: number | undefined;
}

async function run_runner(cmdline: string, cpus = 1): Promise<RunnerResult> {
  const child = spawn(
    lifecycle_assets.runner,
    [
      "--initcpio",
      lifecycle_assets.initramfs_path,
      "--disk",
      lifecycle_assets.rootfs_path,
      "--cpus",
      cpus.toString(),
      "--cmdline",
      cmdline,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let triggered_at: number | undefined;
  const consume = (chunk: Buffer) => {
    output += chunk.toString();
    if (triggered_at === undefined && output.includes("lifecycle: triggering panic")) {
      triggered_at = performance.now();
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  return await with_timeout(
    new Promise<RunnerResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({
          code,
          signal,
          output,
          milliseconds_after_trigger:
            triggered_at === undefined ? undefined : performance.now() - triggered_at,
        });
      });
    }),
    45_000,
  ).catch((error) => {
    child.kill("SIGKILL");
    throw error;
  });
}

test("guest lifecycle terminates the host", async (t) => {
  await t.test("machine.closed follows guest termination", async (t) => {
    await t.test("resolves after poweroff", async () => {
      const { machine } = await run_machine("poweroff");
      await with_timeout(machine.closed);
    });

    await t.test("rejects after a panic with diagnostics visible", async () => {
      const { machine, output } = await run_machine("panic");
      await assert.rejects(with_timeout(machine.closed), MachinePanicError);
      assert.match(output.text, /Kernel panic - not syncing/);
    });
  });

  await t.test("runner exits with the guest lifecycle", async (t) => {
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
      assert.deepEqual(
        { code: result.code, signal: result.signal },
        {
          code: 0,
          signal: null,
        },
      );
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
        result.milliseconds_after_trigger !== undefined &&
          result.milliseconds_after_trigger < 4_000,
        `termination took ${result.milliseconds_after_trigger}ms after the panic trigger`,
      );
    });
  });
});
