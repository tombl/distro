// SPDX-License-Identifier: MIT

import type { Mount } from "../guest/agent.ts";
import { image_mount, type ImageSource } from "./source.ts";

export type { ImageFileHandle, ImageSource } from "./source.ts";

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
    // The only reference to the canonical image in the package, so a bundle
    // contains it only when its application imports lowland/image. This
    // package built it, so it is EROFS.
    return {
      path: "/",
      source: new URL("../../assets/rootfs.erofs", import.meta.url),
      type: "erofs",
      mode: "overlay",
    };
  }
  return image_mount(source);
}
