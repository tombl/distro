// SPDX-License-Identifier: MIT

import { blockDevice } from "@lowland/kernel/virtio/block.js";
import { serveDevice } from "@lowland/kernel/virtio/remote.js";

const configuration = await new Promise((resolve) =>
  addEventListener("message", (event) => resolve(event.data), { once: true }),
);

async function openAccessHandle(handle) {
  // A navigation may start the replacement worker while the old page's worker
  // is still releasing its exclusive OPFS lock. Retry only that lock conflict;
  // every other initialization error must remain visible to workerDevice().
  for (let attempt = 0; ; attempt++) {
    try {
      return await handle.createSyncAccessHandle();
    } catch (error) {
      if (error?.name !== "NoModificationAllowedError" || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}

const access = await openAccessHandle(configuration.handle);
if (configuration.capacity !== undefined) access.truncate(configuration.capacity);
const capacity = access.getSize();

serveDevice(
  self,
  blockDevice({
    capacity,
    read(offset, target) {
      let read = 0;
      while (read < target.byteLength) {
        const n = access.read(target.subarray(read), { at: offset + read });
        if (n === 0) break;
        read += n;
      }
      return read;
    },
    write(offset, data) {
      let written = 0;
      while (written < data.byteLength) {
        const n = access.write(data.subarray(written), { at: offset + written });
        if (n === 0) break;
        written += n;
      }
      return written;
    },
    flush() {
      access.flush();
    },
    close() {
      try {
        access.flush();
      } finally {
        access.close();
      }
    },
  }),
);
