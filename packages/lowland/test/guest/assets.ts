import { readFile } from "node:fs/promises";
import { blockDevice } from "../../src/machine/index.ts";
import type { MachinePlugin } from "../../src/machine/plugin.ts";
import { testAsset } from "../../../../scripts/test-assets.ts";
import type { Mount } from "../../src/guest/index.ts";

async function asset(name: string) {
  return readFile(await testAsset(name));
}

/** The package's own agent initramfs. */
export const agent_initramfs = await readFile(new URL("../../assets/agent.cpio", import.meta.url));
export const rootfs = await asset("rootfs.erofs");
export const ext4_rootfs = await asset("rootfs.ext4");

/** The test system, an EROFS image, as the root beneath a writable overlay. */
export function root_mount(): Mount {
  return { path: "/", source: rootfs, type: "erofs", mode: "overlay" };
}

/**
 * The test system as an ext4 root, writable by default. Pass the same `disk`
 * to boot its storage again: a writable disk is changed in place.
 */
export function ext4_root_mount(
  disk: Uint8Array = new Uint8Array(ext4_rootfs),
  mode: Mount["mode"] = "rw",
): Mount {
  return { path: "/", source: disk, type: "ext4", mode };
}

/** A static guest executable that exercises the guest-side network stack. */
export const network_test = await asset("network-test");

/** A static guest executable whose entrypoint executes Wasm `unreachable`. */
export const user_trap = await asset("user-trap");

/** A static guest executable that compares raw getdents64 and held-directory inode numbers. */
export const getdents_inode = await asset("getdents-inode");

const lifecycle_rootfs = await asset("lifecycle.erofs");
const boot_initramfs = await asset("boot.cpio");

/** BusyBox in an initramfs, for machines that never leave theirs. */
export const busybox_initramfs = boot_initramfs;

export const lifecycle_assets = {
  /** The busybox initramfs that mounts /dev/vda and switches into it. */
  boot: (): MachinePlugin => ({
    configure: (setup) => setup.initramfs.add(boot_initramfs),
  }),
  root: () =>
    blockDevice({
      capacity: lifecycle_rootfs.byteLength,
      read(offset, target) {
        const source = lifecycle_rootfs.subarray(offset, offset + target.byteLength);
        target.set(source);
        return source.byteLength;
      },
    }),
};
