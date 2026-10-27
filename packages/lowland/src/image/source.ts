// SPDX-License-Identifier: MIT

// Image sources as root mounts, apart from the canonical image, so the Linux
// facade can boot your own image without referencing that one.

import type { DiskFileHandle } from "../machine/disk.ts";
import type { Mount } from "../guest/agent.ts";
import { platform } from "./platform.ts";
import { check_bytes, check_image, HEADER_OFFSET, HEADER_SIZE } from "./validate.ts";

/** The parts of a Node `FileHandle` that an image needs. */
export type ImageFileHandle = DiskFileHandle;

/**
 * A filesystem image to boot with `rootImage()`.
 *
 * A string is a file path in Node and a URL, relative to the page, in
 * browsers. A `URL` with the `file:` scheme is a path, and any other `URL` is
 * fetched. Byte arrays, blobs, and responses hold the whole image in memory.
 */
export type ImageSource =
  | string
  | URL
  | ImageFileHandle
  | Uint8Array
  | ArrayBuffer
  | Blob
  | Response;

/** The filesystem of an image whose superblock can be read now, checking it on the way. */
function filesystem_of_source(source: ImageSource): "erofs" | "ext4" | undefined {
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    return check_bytes("the image bytes are not", bytes);
  }
  const path = typeof source === "string" ? source : source instanceof URL ? source : undefined;
  if (path === undefined || (path instanceof URL && path.protocol !== "file:")) return undefined;
  const read = platform.read_header(path, HEADER_OFFSET, HEADER_SIZE);
  if (!read) return undefined;
  const name = path instanceof URL ? decodeURIComponent(path.pathname) : path;
  return check_image(`${name} is not`, read.header, read.size);
}

/** @internal Your own image as `rootImage(source)` mounts it. */
export function image_mount(source: ImageSource): Mount {
  const type = filesystem_of_source(source);
  return { path: "/", source, ...(type && { type }), mode: "overlay" };
}
