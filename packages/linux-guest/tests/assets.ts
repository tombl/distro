// The only nix-aware part of the test suite. The contract is a single
// directory containing initramfs.cpio, rootfs.squashfs, and network-test:
// the nix check points LINUX_GUEST_TEST_ASSETS at it, and outside nix we
// build it ourselves.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ATTRIBUTE = "linux-guest.checks.tests.assets";

async function build() {
  const repository_root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const result = await new Deno.Command("nix", {
    args: ["build", `${repository_root}#${ATTRIBUTE}`, "--no-link", "--print-out-paths"],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`nix build failed for ${ATTRIBUTE}`);
  return new TextDecoder().decode(result.stdout).trim();
}

const directory = Deno.env.get("LINUX_GUEST_TEST_ASSETS") ?? (await build());

export const assets = {
  initramfs: await Deno.readFile(join(directory, "initramfs.cpio")),
  rootfs: await Deno.readFile(join(directory, "rootfs.squashfs")),
};

/** A static guest executable that exercises the guest-side network stack. */
export const network_test = await Deno.readFile(join(directory, "network-test"));
