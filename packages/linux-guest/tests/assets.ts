// The only nix-aware part of the test suite. The contract is a single
// directory containing the guest and lifecycle assets:
// the nix check points LINUX_GUEST_TEST_ASSETS at it, and outside nix we
// build it ourselves.
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const ATTRIBUTE = "linux-guest.checks.tests.assets";
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

const directory = process.env.LINUX_GUEST_TEST_ASSETS ?? (await build());

export const assets = {
  initramfs: await readFile(join(directory, "initramfs.cpio")),
  rootfs: await readFile(join(directory, "rootfs.squashfs")),
};

export const lifecycle_assets = {
  initramfs: await readFile(join(directory, "lifecycle-initramfs.cpio")),
  initramfs_path: join(directory, "lifecycle-initramfs.cpio"),
  rootfs_path: join(directory, "rootfs.squashfs"),
  runner: join(directory, "runner"),
};
