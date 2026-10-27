// SPDX-License-Identifier: MIT

import type { DiskFileHandle } from "@lowland/kernel";
import type { Mount } from "@lowland/guest";
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

/**
 * The canonical Lowland system image, or your own, as the root of the guest
 * agent's mount table, beneath a writable overlay.
 *
 * Without a source this is the canonical image: an EROFS filesystem that
 * contains BusyBox, apk-tools, and CA certificates. apk in it installs signed
 * packages from the public Lowland repository once the machine has
 * networking. A source is your own EROFS or ext4 image.
 *
 * The image is opened read-only and mounted beneath a temporary writable
 * layer in guest memory, so the guest can write to its root, but the image
 * never changes and the writes last only as long as the machine. To keep
 * writes to an ext4 image, use a mount entry of your own instead, such as
 * `{ path: "/", source: "app.ext4", type: "ext4" }`.
 *
 * Bytes, and a file path in Node, are checked for an EROFS or ext4
 * superblock now, which also decides the type. Other sources are fetched or
 * read when the machine boots, and the guest tries each filesystem type.
 * Node reads files on demand, so a machine only loads the blocks the guest
 * touches. Fetched images, including the canonical image in browsers, are
 * downloaded once and shared between machines.
 *
 * @example Boot the canonical image with the guest agent
 * ```ts
 * const guest = guestAgent({ mounts: [rootImage()] });
 * await using machine = await bootMachine({ cpus: 1, plugins: [guest] });
 * ```
 *
 * @example Boot an image from a file
 * ```ts
 * const guest = guestAgent({ mounts: [rootImage("app.erofs")] });
 * ```
 */
export function rootImage(source?: ImageSource): Mount {
  if (source === undefined) {
    // This package built it, so it is EROFS.
    return {
      path: "/",
      source: new URL("../rootfs.erofs", import.meta.url),
      type: "erofs",
      mode: "overlay",
    };
  }
  const type = filesystem_of_source(source);
  return { path: "/", source, ...(type && { type }), mode: "overlay" };
}
