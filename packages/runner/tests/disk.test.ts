import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function required_environment(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}

const runner = required_environment("LINUX_RUNNER_TEST_RUNNER");
const root = required_environment("LINUX_RUNNER_TEST_ROOT_DISK");

async function run_disk(disk: string, command: string) {
  const child = spawn(runner, ["--cpus", "1", "--disk", root, "--disk", disk], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let sent = false;
  const consume = (chunk: Buffer) => {
    output += chunk.toString();
    if (!sent && output.includes("~ #")) {
      sent = true;
      child.stdin.end(`${command}\n/sbin/poweroff -f\n`);
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
  } finally {
    clearTimeout(timeout);
  }
  assert.deepEqual(result, { code: 0, signal: null }, output);
  return output;
}

test("runner persists a virtio disk served by a filesystem worker", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "linux-runner-disk-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const disk = path.join(temporary, "disk.img");
  await writeFile(disk, new Uint8Array(1024 * 1024));
  const marker = "node-worker-virtio-round-trip";

  await run_disk(
    disk,
    `until [ -b /dev/vdb ]; do sleep 0.1; done; printf '%s\\n' '${marker}' | dd of=/dev/vdb bs=512 conv=fsync 2>/dev/null`,
  );
  assert.equal((await readFile(disk, "utf8")).split("\n", 1)[0], marker);

  const output = await run_disk(
    disk,
    "until [ -b /dev/vdb ]; do sleep 0.1; done; dd if=/dev/vdb bs=512 count=1 2>/dev/null | head -n 1",
  );
  assert.match(output, new RegExp(marker));
});
