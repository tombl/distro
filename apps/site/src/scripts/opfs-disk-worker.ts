// SPDX-License-Identifier: MIT

import { blockDevice, serveDevice, serveDeviceError } from "lowland/machine";

type Configuration = {
  handle: FileSystemFileHandle;
  capacity?: number;
  serial?: string;
};

const configuration = await new Promise<Configuration>((resolve) =>
  addEventListener("message", (event: MessageEvent<Configuration>) => resolve(event.data), {
    once: true,
  }),
);

async function openAccessHandle(handle: FileSystemFileHandle): Promise<FileSystemSyncAccessHandle> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await handle.createSyncAccessHandle();
    } catch (error) {
      if (
        !(error instanceof DOMException) ||
        error.name !== "NoModificationAllowedError" ||
        attempt === 7
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}

// A setup failure, such as the disk being open in another tab, must reach
// workerDevice() on the page with its name and message.
try {
  const access = await openAccessHandle(configuration.handle);
  if (configuration.capacity !== undefined) access.truncate(configuration.capacity);
  const capacity = access.getSize();

  serveDevice(
    self,
    blockDevice(
      {
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
            const n = access.write(data.subarray(written), {
              at: offset + written,
            });
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
      },
      { serial: configuration.serial },
    ),
  );
} catch (error) {
  serveDeviceError(self, error);
}
