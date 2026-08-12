// SPDX-License-Identifier: MIT

import { blockDevice, serveDevice } from "@lowland/kernel";
import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("disk worker requires a parent port");

let readonly = false;
let file: number;
try {
  file = openSync(workerData.path, "r+");
} catch {
  readonly = true;
  file = openSync(workerData.path, "r");
}
const { size: capacity } = fstatSync(file);

serveDevice(
  parentPort,
  blockDevice({
    capacity,
    read(offset, target) {
      let read = 0;
      while (read < target.byteLength) {
        const n = readSync(file, target, read, target.byteLength - read, offset + read);
        if (n === 0) break;
        read += n;
      }
      return read;
    },
    write: readonly
      ? undefined
      : (offset, data) => {
          let written = 0;
          while (written < data.byteLength) {
            const n = writeSync(file, data, written, data.byteLength - written, offset + written);
            if (n === 0) break;
            written += n;
          }
          return written;
        },
    flush: readonly ? undefined : () => fsyncSync(file),
    close() {
      try {
        if (!readonly) fsyncSync(file);
      } finally {
        closeSync(file);
      }
    },
  }),
);
