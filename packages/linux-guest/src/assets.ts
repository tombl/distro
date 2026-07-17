export const rootfsSize = Number("@ROOTFS_SIZE@");

async function fetch_bytes(path: string) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) {
    throw new Error(`failed to fetch ${path}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export const rootfs = fetch_bytes("../rootfs.squashfs");
export const initramfs = fetch_bytes("../initramfs.cpio");
