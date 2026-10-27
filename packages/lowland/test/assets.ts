// SPDX-License-Identifier: MIT

// The only Nix-aware part of the test suite. The Nix check points
// LOWLAND_TEST_ASSETS at lowland/image's test assets, and outside Nix the
// tests build them.
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ATTRIBUTE = "lowland.package.checks.image.assets";

async function build() {
  const repository_root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const { stdout } = await promisify(execFile)("nix", [
    "build",
    `${repository_root}#${ATTRIBUTE}`,
    "--no-link",
    "--print-out-paths",
  ]);
  return stdout.trim();
}

const directory = process.env.LOWLAND_TEST_ASSETS ?? (await build());

/** A local BusyBox package with no dependencies. */
export const busybox_package = join(directory, "busybox.apk");

/** Copies the writable ext4 test system into `scratch`. */
export async function ext4_root(scratch: string) {
  const path = join(scratch, "root.ext4");
  await copyFile(join(directory, "rootfs.ext4"), path);
  await chmod(path, 0o644);
  return path;
}

/** A scratch directory removed when disposed. */
export async function scratch_directory() {
  const path = await mkdtemp(join(tmpdir(), "lowland-test-"));
  return {
    path,
    [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }),
  };
}
