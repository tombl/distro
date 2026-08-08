// The only nix-aware part of the test suite. The contract is a single
// directory containing the guest and lifecycle assets:
// the nix check points LINUX_GUEST_TEST_ASSETS at it, and outside nix we
// build it ourselves.
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { blockDevice } from "../src/index.ts";

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

export const rootfs = await readFile(join(directory, "rootfs.squashfs"));

export function root_device() {
  return blockDevice({
    capacity: rootfs.byteLength,
    read(offset, length) {
      return rootfs.subarray(offset, offset + length);
    },
  });
}

/** A static guest executable that exercises the guest-side network stack. */
export const network_test = await readFile(join(directory, "network-test"));

/** A static guest executable whose entrypoint executes Wasm `unreachable`. */
export const user_trap = await readFile(join(directory, "user-trap"));

/** A static guest executable that compares raw getdents64 and held-directory inode numbers. */
export const getdents_inode = await readFile(join(directory, "getdents-inode"));

export const lifecycle_assets = {
  initramfs: await readFile(join(directory, "lifecycle-initramfs.cpio")),
};
