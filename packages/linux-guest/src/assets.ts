export const rootfsSize = Number("@ROOTFS_SIZE@");

async function fetchBytes(path: string) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) {
    throw new Error(`failed to fetch ${path}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export const rootfs = fetchBytes("../rootfs.squashfs");
export const initramfs = fetchBytes("../initramfs.cpio");
