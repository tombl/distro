import { readFile } from "node:fs/promises";
import { blockDevice } from "@lowland/kernel";
import { testAsset } from "../../../scripts/test-assets.ts";

async function asset(name: string) {
  return readFile(await testAsset(name));
}

export const agent_disk = await asset("agent.img");
export const rootfs = await asset("rootfs.erofs");
export const ext4_rootfs = await asset("rootfs.ext4");
export const wrong_rootfs = await asset("wrong-root.erofs");

export function root_device() {
  return blockDevice({
    capacity: rootfs.byteLength,
    read(offset, target) {
      const source = rootfs.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  });
}

export function ext4_root_device(disk = new Uint8Array(ext4_rootfs)) {
  return blockDevice({
    capacity: disk.byteLength,
    read(offset, target) {
      const source = disk.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
    write(offset, data) {
      disk.set(data, offset);
      return data.byteLength;
    },
    flush() {},
  });
}

export function readonly_ext4_root_device(disk: Uint8Array = ext4_rootfs) {
  return blockDevice({
    capacity: disk.byteLength,
    read(offset, target) {
      const source = disk.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  });
}

export function agent_device() {
  return blockDevice({
    capacity: agent_disk.byteLength,
    read(offset, target) {
      const source = agent_disk.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  });
}

export function wrong_root_device() {
  return blockDevice({
    capacity: wrong_rootfs.byteLength,
    read(offset, target) {
      const source = wrong_rootfs.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  });
}

/** A static guest executable that exercises the guest-side network stack. */
export const network_test = await asset("network-test");

/** A static guest executable whose entrypoint executes Wasm `unreachable`. */
export const user_trap = await asset("user-trap");

/** A static guest executable that compares raw getdents64 and held-directory inode numbers. */
export const getdents_inode = await asset("getdents-inode");

const lifecycle_rootfs = await asset("lifecycle.erofs");

export const lifecycle_assets = {
  initramfs: await asset("boot.cpio"),
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
