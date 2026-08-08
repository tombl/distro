import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function required_environment(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}

const runner = required_environment("LINUX_RUNNER_TEST_RUNNER");

test(
  "runner preserves console input supplied at launch",
  { timeout: 45_000 },
  async (t) => {
    const child = spawn(runner, ["--cpus", "1"], {
      signal: t.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

    // Keep the expected marker out of the input byte stream so tty echo
    // cannot make the assertion pass before the shell executes the script.
    child.stdin.end(
      "printf '%s%s\\n' LAUNCH_INPUT_ PRESERVED\n/sbin/poweroff -f\n",
    );

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    assert.deepEqual(result, { code: 0, signal: null }, output);
    assert.match(output, /LAUNCH_INPUT_PRESERVED/);
  },
);
