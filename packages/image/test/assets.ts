// SPDX-License-Identifier: MIT

// The nix check points LOWLAND_IMAGE_TEST_EXT4 at a writable ext4 copy of the
// canonical system, and outside nix we build it ourselves.

import { execFile } from "node:child_process";
import { copyFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ATTRIBUTE = "lowland-image.checks.tests.ext4-root";
const exec_file = promisify(execFile);

async function build() {
  const repository_root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const { stdout } = await exec_file("nix", [
    "build",
    `${repository_root}#${ATTRIBUTE}`,
    "--no-link",
    "--print-out-paths",
  ]);
  return stdout.trim();
}

/** The canonical image shipped in this package. */
export const canonical_image = fileURLToPath(new URL("../rootfs.erofs", import.meta.url));

const ext4_image = process.env.LOWLAND_IMAGE_TEST_EXT4 ?? (await build());

/** A scratch directory removed when disposed. */
export async function scratch_directory() {
  const path = await mkdtemp(join(tmpdir(), "lowland-image-"));
  return {
    path,
    [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }),
  };
}

/** Copies the ext4 system into `directory` as a file the test may write. */
export async function writable_ext4_copy(directory: string) {
  const path = join(directory, "root.ext4");
  await copyFile(ext4_image, path);
  await chmod(path, 0o644);
  return path;
}
