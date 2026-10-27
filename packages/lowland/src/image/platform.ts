// SPDX-License-Identifier: MIT

// The seam between web APIs and Node builtins. Selected at runtime by the
// presence of process.getBuiltinModule, so bundlers only ever see the web path
// and never try to resolve Node builtins.

interface Platform {
  /**
   * Reads `length` bytes at `offset` of a file, and its size, now. Returns
   * `undefined` where files cannot be read synchronously.
   */
  read_header(
    path: string | URL,
    offset: number,
    length: number,
  ): { header: Uint8Array; size: number } | undefined;
}

const web: Platform = {
  read_header: () => undefined,
};

interface GetBuiltinModule {
  (id: "node:fs"): {
    openSync(path: string | URL, flags: "r"): number;
    fstatSync(fd: number): { size: number };
    readSync(
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): number;
    closeSync(fd: number): void;
  };
}

interface NodeProcess {
  getBuiltinModule?: GetBuiltinModule;
}

function node(getBuiltinModule: GetBuiltinModule): Platform {
  const { openSync, fstatSync, readSync, closeSync } = getBuiltinModule("node:fs");
  return {
    read_header(path, offset, length) {
      const fd = openSync(path, "r");
      try {
        const { size } = fstatSync(fd);
        const header = new Uint8Array(length);
        let read = 0;
        while (read < length) {
          const n = readSync(fd, header, read, length - read, offset + read);
          if (n === 0) break;
          read += n;
        }
        return { header: header.subarray(0, read), size };
      } finally {
        closeSync(fd);
      }
    },
  };
}

const getBuiltinModule = (globalThis as { process?: NodeProcess }).process?.getBuiltinModule;

/** @internal */
export const platform: Platform = getBuiltinModule ? node(getBuiltinModule) : web;
