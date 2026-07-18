export interface GuestAssets {
  initramfs: Uint8Array;
  rootfs: Uint8Array;
}

async function fetch_bytes(path: string) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) {
    throw new Error(`failed to fetch ${path}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** The boot assets bundled with the published npm package. */
export async function packaged_assets(): Promise<GuestAssets> {
  const [initramfs, rootfs] = await Promise.all([
    fetch_bytes("../initramfs.cpio"),
    fetch_bytes("../rootfs.squashfs"),
  ]);
  return { initramfs, rootfs };
}
