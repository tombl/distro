// SPDX-License-Identifier: MIT

// Both supported filesystems keep their superblock 1024 bytes into the image.
// A source without one is usually an error page served in place of an asset,
// such as a dev server's HTML fallback, so reject it before the kernel sees it.

/** @internal The offset of the superblock bytes that identify an image. */
export const HEADER_OFFSET = 1024;
/** @internal The number of superblock bytes that identify an image. */
export const HEADER_SIZE = 64;

// The smallest image that can hold a 1024-byte ext4 superblock after the boot
// block. EROFS images are always larger.
const MINIMUM_SIZE = 2048;
const EROFS_MAGIC = 0xe0f5e1e2;
const EXT4_MAGIC = 0xef53;
const EXT4_MAGIC_OFFSET = 56;

/** @internal A filesystem that an image can contain. */
export type Filesystem = "erofs" | "ext4";

/** @internal Identifies the filesystem whose superblock starts `header`. */
export function filesystem_of(header: Uint8Array): Filesystem | undefined {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.byteLength >= 4 && view.getUint32(0, true) === EROFS_MAGIC) return "erofs";
  if (
    header.byteLength >= EXT4_MAGIC_OFFSET + 2 &&
    view.getUint16(EXT4_MAGIC_OFFSET, true) === EXT4_MAGIC
  ) {
    return "ext4";
  }
  return undefined;
}

/** @internal The superblock bytes of an image held in memory. */
export function header_of(bytes: Uint8Array) {
  return bytes.subarray(HEADER_OFFSET, HEADER_OFFSET + HEADER_SIZE);
}

/**
 * @internal Throws unless `header`, read from `HEADER_OFFSET` of an image of
 * `size` bytes, starts an EROFS or ext4 superblock.
 */
export function check_image(
  subject: string,
  header: Uint8Array,
  size: number,
  content_type?: string | null,
): Filesystem {
  const type = content_type?.split(";")[0]?.trim().toLowerCase() || undefined;
  const got = type ? `${type}, ${size} bytes` : `${size} bytes`;
  if (type === "text/html" || size < MINIMUM_SIZE) {
    throw new Error(`${subject} a filesystem image: got ${got}`);
  }
  const filesystem = filesystem_of(header);
  if (!filesystem) {
    throw new Error(`${subject} a filesystem image: got ${got} with no EROFS or ext4 superblock`);
  }
  return filesystem;
}

/** @internal Validates a whole image held in memory. */
export function check_bytes(subject: string, bytes: Uint8Array, content_type?: string | null) {
  return check_image(subject, header_of(bytes), bytes.byteLength, content_type);
}

/**
 * @internal Throws if `writable` was asked of an EROFS image, which the
 * kernel only ever mounts read-only.
 */
export function check_writable(name: string, filesystem: Filesystem | undefined) {
  if (filesystem === "erofs") {
    throw new Error(`${name}: EROFS images are read-only; writable has no effect`);
  }
}
