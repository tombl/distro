import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function required_environment(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}

const runner = required_environment("LINUX_RUNNER_TEST_RUNNER");

test("runner mounts writable and read-only host shares", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "linux-runner-shares-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const writable = path.join(temporary, "writable");
  const readonly = path.join(temporary, "readonly");
  await Promise.all([mkdir(writable), mkdir(readonly)]);
  await writeFile(path.join(readonly, "host.txt"), "from host\n");

  const child = spawn(
    runner,
    [
      "--cpus",
      "1",
      "--share",
      `${writable}:/workspace/writable share`,
      "--share-ro",
      `${readonly}:/workspace/read only`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stdin.end(`
printf 'from guest\\n' > '/workspace/writable share/guest.txt'
cat '/workspace/read only/host.txt'
if printf 'changed\\n' > '/workspace/read only/host.txt'; then
  printf '%s%s\\n' READ_ONLY_WRITE_ SUCCEEDED
else
  printf '%s%s\\n' READ_ONLY_ ENFORCED
fi
/sbin/poweroff -f
`);

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  assert.deepEqual(result, { code: 0, signal: null }, output);
  assert.match(output, /from host/);
  assert.match(output, /READ_ONLY_ENFORCED/);
  assert.doesNotMatch(output, /READ_ONLY_WRITE_SUCCEEDED/);
  assert.equal(await readFile(path.join(writable, "guest.txt"), "utf8"), "from guest\n");
  assert.equal(await readFile(path.join(readonly, "host.txt"), "utf8"), "from host\n");
});
