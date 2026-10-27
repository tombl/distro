// SPDX-License-Identifier: MIT

// Builds from the live public repository, so this only runs through
// `pnpm test:online` and never in Nix checks: the repository is whatever main
// last published, and it needs the network.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootMachine } from "../../../src/machine/index.ts";
import { guestAgent } from "../../../src/guest/index.ts";
import { buildImage } from "../../../src/image/build.ts";
import { rootImage } from "../../../src/image/index.ts";
import { jq_package } from "../assets.ts";

test("builds an image from the public repository and a local package", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lowland-image-online-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.json");
  await writeFile(input, '{"answer": 42}\n');
  const output = join(directory, "image.erofs");
  await buildImage({
    // busybox is verified against the repository's key, and the local jq
    // installs after it without the network.
    packages: ["busybox", jq_package],
    files: {
      "/srv/input.json": input,
      "/usr/local/bin/answer": {
        source: new URL("../answer.sh", import.meta.url).pathname,
        mode: "0755",
      },
    },
    output,
  });

  const guest = guestAgent({ mounts: [rootImage(output)] });
  const machine = await bootMachine({ cpus: 1, plugins: [guest] });
  t.after(() => machine[Symbol.asyncDispose]());
  const result = await guest.run(["/usr/local/bin/answer"]);
  assert.deepEqual(result.status, { success: true, code: 0, signal: null });
  assert.equal(new TextDecoder().decode(result.stdout), "42\n");
});
