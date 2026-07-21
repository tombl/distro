import assert from "node:assert/strict";
import { SystemError } from "../src/index.ts";
import { guest_test } from "./fixture.ts";
import { collect } from "./helpers.ts";

guest_test("guest", async (t, fixture) => {
  const guest = await fixture.spawn();

  await t.test("mounts the root filesystem read-only", async () => {
    await assert.rejects(
      guest.fs.writeTextFile("/immutable.txt", "nope"),
      (error) => error instanceof SystemError && error.code === "EROFS",
    );
  });

  await t.test("mounts devpts", async () => {
    const probe = await guest.exec([
      "sh",
      "-c",
      "test -c /dev/ptmx && grep -q ' /dev/pts devpts ' /proc/mounts",
    ]);
    const [error, status] = await Promise.all([collect(probe.stderr), probe.status]);
    assert.deepEqual(status, { success: true, code: 0, signal: null });
    assert.equal(error.byteLength, 0);
  });
});
