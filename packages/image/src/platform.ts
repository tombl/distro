// SPDX-License-Identifier: MIT

// The seam between web APIs and Node builtins. Selected at runtime by the
// presence of process.getBuiltinModule, so bundlers only ever see the web path
// and never try to resolve Node builtins.

import type { BlockDeviceStorage } from "@lowland/kernel";
import { check_image, HEADER_OFFSET, HEADER_SIZE } from "./validate.ts";

/**
 * The parts of a Node `FileHandle` that an image needs.
 *
 * `write()` and `datasync()` are only called for writable images.
 */
export interface ImageFileHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
  stat(): Promise<{ size: number }>;
  datasync(): Promise<void>;
}

interface Platform {
  /** Resolves a string source to a path in Node or a URL in browsers. */
  resolve(source: string): string | URL;
  /** Opens a file path as block storage. */
  open_path(path: string | URL, writable: boolean): Promise<BlockDeviceStorage>;
}

const web: Platform = {
  resolve(source) {
    return new URL(source, globalThis.location?.href);
  },
  open_path(path) {
    return Promise.reject(new Error(`cannot open ${path}: files are only available in Node`));
  },
};

/** @internal Wraps an open file in block storage, validating it with one small read. */
export async function file_storage(
  subject: string,
  handle: ImageFileHandle,
  writable: boolean,
): Promise<BlockDeviceStorage> {
  async function read(offset: number, target: Uint8Array) {
    let total = 0;
    while (total < target.byteLength) {
      const { bytesRead } = await handle.read(
        target,
        total,
        target.byteLength - total,
        offset + total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return total;
  }

  const { size } = await handle.stat();
  const header = new Uint8Array(HEADER_SIZE);
  const length = size < HEADER_OFFSET + HEADER_SIZE ? 0 : await read(HEADER_OFFSET, header);
  check_image(subject, header.subarray(0, length), size);

  const storage: BlockDeviceStorage = { capacity: size, read };
  if (writable) {
    storage.write = async (offset, data) => {
      let total = 0;
      while (total < data.byteLength) {
        const { bytesWritten } = await handle.write(
          data,
          total,
          data.byteLength - total,
          offset + total,
        );
        if (bytesWritten === 0) break;
        total += bytesWritten;
      }
      return total;
    };
    storage.flush = () => handle.datasync();
  }
  return storage;
}

interface GetBuiltinModule {
  (id: "node:fs/promises"): {
    open(
      path: string | URL,
      flags: "r" | "r+",
    ): Promise<ImageFileHandle & { close(): Promise<void> }>;
  };
}

interface NodeProcess {
  getBuiltinModule?: GetBuiltinModule;
}

// Node reads files on demand, so a machine only pages in the blocks the guest
// touches.
function node(getBuiltinModule: GetBuiltinModule): Platform {
  const { open } = getBuiltinModule("node:fs/promises");
  return {
    resolve: (source) => source,
    async open_path(path, writable) {
      const handle = await open(path, writable ? "r+" : "r");
      try {
        const name = path instanceof URL ? decodeURIComponent(path.pathname) : path;
        const storage = await file_storage(`${name} is not`, handle, writable);
        storage.close = () => handle.close();
        return storage;
      } catch (error) {
        await handle.close();
        throw error;
      }
    },
  };
}

const getBuiltinModule = (globalThis as { process?: NodeProcess }).process?.getBuiltinModule;

/** @internal */
export const platform: Platform = getBuiltinModule ? node(getBuiltinModule) : web;
