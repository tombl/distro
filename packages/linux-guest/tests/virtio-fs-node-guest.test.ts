import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileSystemDevice } from "../src/index.ts";
import { FS } from "../src/node.ts";
import { guest_test } from "./fixture.ts";

guest_test("node virtio-fs adapter mounts in a guest", async (t, fixture) => {
  const shared = await mkdtemp(path.join(tmpdir(), "linux-guest-node-mount-"));
  t.after(() => rm(shared, { recursive: true, force: true }));
  const filesystem = new FS(shared);
  const guest = await fixture.spawn([
    fileSystemDevice(filesystem, { tag: "node-test", cache: false }),
  ]);
  const mounted = await guest.exec([
    "sh",
    "-c",
    "mkdir -p /workspace/shared && mount -t virtiofs node-test /workspace/shared",
  ]);
  const stderr = new Response(mounted.stderr).text();
  assert.equal((await mounted.status).success, true, await stderr);

  await guest.fs.writeTextFile("/workspace/shared/from-guest", "guest data");
  assert.equal(await readFile(path.join(shared, "from-guest"), "utf8"), "guest data");

  await writeFile(path.join(shared, "from-host"), "host data");
  assert.equal(await guest.fs.readTextFile("/workspace/shared/from-host"), "host data");

  await guest.fs.rename("/workspace/shared/from-guest", "/workspace/shared/renamed");
  assert.equal(await readFile(path.join(shared, "renamed"), "utf8"), "guest data");
});
