// SPDX-License-Identifier: MIT

import type { MachinePlugin } from "@lowland/kernel/plugin";
import { image_plugin, type ResolvedSource } from "./image.ts";
import { platform, type ImageFileHandle } from "./platform.ts";
import { check_writable, filesystem_of, header_of } from "./validate.ts";

export type { ImageFileHandle };

/**
 * A filesystem image to attach with `rootImage()`.
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

/** Options for `rootImage()`. */
export interface RootImageOptions {
  /**
   * Lets the guest write to an ext4 image, which defaults to read-only.
   *
   * The guest agent boots a read-only image beneath a temporary writable
   * overlay, so the guest can still write to its root, but those changes are
   * discarded when the machine closes. A writable ext4 image keeps them.
   *
   * A path is opened for reading and writing, a file handle must already be
   * open for writing, and byte arrays are modified in place. Fetched images,
   * blobs, and responses cannot be writable. EROFS is always read-only, so a
   * writable EROFS image is rejected: immediately for bytes, and when the
   * machine boots for a path or file handle. Writes reach the source when the
   * guest flushes them, such as by running `sync` or unmounting the
   * filesystem, so data the guest has not flushed before the machine closes
   * may be lost.
   */
  writable?: boolean;
}

function is_file_handle(source: object): source is ImageFileHandle {
  return typeof (source as Partial<ImageFileHandle>).read === "function" && "stat" in source;
}

function resolve(source: ImageSource): ResolvedSource {
  if (typeof source === "string") source = platform.resolve(source);
  if (typeof source === "string") return { kind: "path", path: source };
  if (source instanceof URL) {
    return source.protocol === "file:"
      ? { kind: "path", path: source }
      : { kind: "url", url: source };
  }
  if (source instanceof Uint8Array) return { kind: "bytes", bytes: source };
  if (source instanceof ArrayBuffer) return { kind: "bytes", bytes: new Uint8Array(source) };
  if (source instanceof Blob || source instanceof Response) return { kind: "blob", blob: source };
  if (is_file_handle(source)) return { kind: "handle", handle: source };
  throw new TypeError(
    "rootImage() source must be a path, URL, file handle, bytes, blob, or response",
  );
}

/**
 * Attaches a filesystem image as a block device, defaulting to the canonical Lowland system image.
 *
 * Without a source this attaches the canonical image, an EROFS filesystem
 * labeled `LOWLAND_ROOT` that contains BusyBox, apk-tools, and CA
 * certificates. The guest agent from `@lowland/guest` finds a root filesystem
 * by that label, so a custom image needs the same label to become the root.
 * apk in the canonical image installs signed packages from the public Lowland
 * repository once the machine has networking.
 *
 * Node reads files on demand, so a machine only loads the blocks the guest
 * touches. Fetched images, including the canonical image in browsers, are
 * downloaded once and shared between machines. Every image must contain an
 * EROFS or ext4 filesystem, and a source that does not, such as an HTML error
 * page, is rejected when the machine boots.
 *
 * The returned plugin can be passed to any number of machines. A file handle
 * stays open after the machines close, and a writable image should only be
 * attached to one running machine at a time.
 *
 * @example Boot the canonical image with the guest agent
 * ```ts
 * const guest = guestAgent();
 * await using machine = await bootMachine({
 *   cpus: 1,
 *   plugins: [rootImage(), guest],
 * });
 * ```
 *
 * @example Boot a writable ext4 image from a file
 * ```ts
 * const guest = guestAgent();
 * await using machine = await bootMachine({
 *   cpus: 1,
 *   plugins: [rootImage("app.ext4", { writable: true }), guest],
 * });
 * ```
 */
export function rootImage(source?: ImageSource, options: RootImageOptions = {}): MachinePlugin {
  const writable = options.writable ?? false;
  const resolved = resolve(source ?? new URL("../rootfs.erofs", import.meta.url));
  if (writable && source === undefined) {
    throw new Error("the canonical image cannot be writable");
  }
  if (writable && (resolved.kind === "url" || resolved.kind === "blob")) {
    throw new Error("a writable image needs a file path, file handle, or bytes");
  }
  // Bytes can be checked now. Files are checked when the machine boots.
  if (writable && resolved.kind === "bytes") {
    check_writable("the image bytes", filesystem_of(header_of(resolved.bytes)));
  }
  return image_plugin(resolved, writable);
}
