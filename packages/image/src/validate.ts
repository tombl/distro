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

/**
 * @internal Throws unless `header`, read from `HEADER_OFFSET` of an image of
 * `size` bytes, starts an EROFS or ext4 superblock.
 */
export function check_image(
  subject: string,
  header: Uint8Array,
  size: number,
  content_type?: string | null,
) {
  const type = content_type?.split(";")[0]?.trim().toLowerCase() || undefined;
  const got = type ? `${type}, ${size} bytes` : `${size} bytes`;
  if (type === "text/html" || size < MINIMUM_SIZE) {
    throw new Error(`${subject} a filesystem image: got ${got}`);
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const erofs = header.byteLength >= 4 && view.getUint32(0, true) === EROFS_MAGIC;
  const ext4 =
    header.byteLength >= EXT4_MAGIC_OFFSET + 2 &&
    view.getUint16(EXT4_MAGIC_OFFSET, true) === EXT4_MAGIC;
  if (!erofs && !ext4) {
    throw new Error(`${subject} a filesystem image: got ${got} with no EROFS or ext4 superblock`);
  }
}

/** @internal Validates a whole image held in memory. */
export function check_bytes(subject: string, bytes: Uint8Array, content_type?: string | null) {
  check_image(
    subject,
    bytes.subarray(HEADER_OFFSET, HEADER_OFFSET + HEADER_SIZE),
    bytes.byteLength,
    content_type,
  );
}
