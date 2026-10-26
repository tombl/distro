// SPDX-License-Identifier: MIT

// The only Nix-aware part of the test suite. The Nix check points
// LOWLAND_IMAGE_TEST_ASSETS at the asset directory, and outside Nix the tests
// build it themselves.
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ATTRIBUTE = "lowland-image.package.checks.tests.assets";

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

const directory = process.env.LOWLAND_IMAGE_TEST_ASSETS ?? (await build());

/** A local BusyBox package with no dependencies, which creates /usr/bin. */
export const busybox_package = join(directory, "busybox.apk");

/** A local jq package with no dependencies. */
export const jq_package = join(directory, "jq.apk");

/** A repository directory whose `wasm32/Packages.adb` index of jq is unsigned. */
export const unsigned_repository = join(directory, "unsigned-repository");

/** The canonical image shipped in this package. */
export const canonical_image = fileURLToPath(new URL("../rootfs.erofs", import.meta.url));

/** A scratch directory removed when disposed. */
export async function scratch_directory() {
  const path = await mkdtemp(join(tmpdir(), "lowland-image-"));
  return {
    path,
    [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }),
  };
}

/** Copies the ext4 system into `scratch` as a file the test may write. */
export async function writable_ext4_copy(scratch: string) {
  const path = join(scratch, "root.ext4");
  await copyFile(join(directory, "rootfs.ext4"), path);
  await chmod(path, 0o644);
  return path;
}
