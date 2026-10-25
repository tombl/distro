// SPDX-License-Identifier: MIT

import { blockDevice } from "@lowland/kernel";
import type { MachinePlugin } from "@lowland/kernel/plugin";
import { platform } from "./platform.ts";

/** @internal Attaches an image shipped in this package as a read-only block device. */
export function packaged_image(url: URL): MachinePlugin {
  return {
    async configure(setup) {
      setup.devices.add(blockDevice(await platform.open_image(url)));
    },
  };
}
