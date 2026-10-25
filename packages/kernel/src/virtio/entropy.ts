// SPDX-License-Identifier: MIT

import { assert } from "../util.ts";
import { type Device, public_handle, VirtioDevice } from "./device.ts";
import type { Virtqueue } from "./queue.ts";

class EntropyDevice extends VirtioDevice {
  constructor() {
    super({ id: 4, queues: 1 });
  }

  protected kick(_vq: number, queue: Virtqueue) {
    for (const chain of queue) {
      let n = 0;
      for (const { array, writable } of chain) {
        assert(writable);

        // can't use crypto.getRandomValues on a SharedArrayBuffer
        const arr = new Uint8Array(array.length);
        crypto.getRandomValues(arr);
        array.set(arr);

        n += array.byteLength;
      }
      chain.release(n);
    }
  }
}

/** A virtio entropy source, feeding the guest's randomness pool from `crypto.getRandomValues`. */
export function entropyDevice(): Device {
  return public_handle(new EntropyDevice(), {});
}
