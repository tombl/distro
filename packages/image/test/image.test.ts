// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { bootMachine } from "@lowland/kernel";
import { guestAgent } from "@lowland/guest";
import { rootImage } from "../src/index.ts";

const decoder = new TextDecoder();

test("boots the root image with the guest agent", async (t) => {
  const guest = guestAgent();
  await using machine = await bootMachine({
    cpus: 1,
    plugins: [rootImage(), guest],
  });
  void machine.bootConsole.pipeTo(new WritableStream());

  await t.test("runs uname", async () => {
    const result = await guest.run(["uname", "-a"]);
    assert.deepEqual(result.status, { success: true, code: 0, signal: null });
    assert.match(decoder.decode(result.stdout), /^Linux /);
  });

  await t.test("runs apk", async () => {
    const result = await guest.run(["apk", "--version"]);
    assert.deepEqual(result.status, { success: true, code: 0, signal: null });
    assert.match(decoder.decode(result.stdout), /^apk-tools 3\./);
  });

  await t.test("configures the public repository", async () => {
    const repositories = await guest.fs.readTextFile("/etc/apk/repositories");
    assert.equal(repositories, "http://assets.low.land/apk/wasm32/Packages.adb\n");
    await guest.fs.stat("/etc/apk/keys/site.rsa.pub");
    await guest.fs.stat("/etc/ssl/cert.pem");
  });
});
