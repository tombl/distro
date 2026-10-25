// SPDX-License-Identifier: MIT

import type { MachinePlugin } from "@lowland/kernel/plugin";
import { packaged_image } from "./packaged.ts";

/**
 * Attaches the canonical Lowland system image as a read-only block device.
 *
 * The image is an EROFS filesystem labeled `LOWLAND_ROOT` that contains
 * BusyBox, apk-tools, and CA certificates. The guest agent from
 * `@lowland/guest` finds it by that label and makes it the root filesystem.
 * apk is configured to install signed packages from the public Lowland
 * repository once the machine has networking.
 *
 * The image is loaded relative to this module. Node reads it from disk on
 * demand, and browsers fetch it once and share it between machines. The
 * returned plugin can be passed to any number of machines.
 *
 * @example Boot the image with the guest agent
 * ```ts
 * const guest = guestAgent();
 * await using machine = await bootMachine({
 *   cpus: 1,
 *   plugins: [rootImage(), guest],
 * });
 * ```
 */
export function rootImage(): MachinePlugin {
  return packaged_image(new URL("../rootfs.erofs", import.meta.url));
}
