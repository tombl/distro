// SPDX-License-Identifier: MIT

import { blockDevice, serveDevice } from "lowland/machine";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  readvSync,
  writeSync,
  writevSync,
} from "node:fs";
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

/** The vectors left after the first `skip` bytes. */
function slice_vectors(vectors: readonly Uint8Array[], skip: number) {
  const rest: Uint8Array[] = [];
  for (const vector of vectors) {
    if (skip >= vector.byteLength) {
      skip -= vector.byteLength;
      continue;
    }
    rest.push(vector.subarray(skip));
    skip = 0;
  }
  return rest;
}

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
    readv(offset, targets) {
      // One system call for the whole request in the common case.
      const length = targets.reduce((total, target) => total + target.byteLength, 0);
      let read = readvSync(file, targets, offset);
      while (read < length) {
        const rest = slice_vectors(targets, read);
        const n = readvSync(file, rest, offset + read);
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
    writev: readonly
      ? undefined
      : (offset, sources) => {
          const length = sources.reduce((total, source) => total + source.byteLength, 0);
          let written = writevSync(file, sources, offset);
          while (written < length) {
            const n = writevSync(file, slice_vectors(sources, written), offset + written);
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
