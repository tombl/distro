// SPDX-License-Identifier: MIT

// The seam between web APIs and Node builtins. Selected at runtime by the
// presence of process.getBuiltinModule, so bundlers only ever see the web path
// and never try to resolve Node builtins.

import type { BlockStorage } from "@lowland/kernel";

interface Platform {
  open_image(url: URL): Promise<BlockStorage>;
}

function memory_storage(bytes: Uint8Array): BlockStorage {
  return {
    capacity: bytes.byteLength,
    read(offset, target) {
      const source = bytes.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  };
}

// Browsers fetch each image once and serve every machine from that copy.
const fetched = new Map<string, Promise<Uint8Array>>();

const web: Platform = {
  async open_image(url) {
    let bytes = fetched.get(url.href);
    if (!bytes) {
      bytes = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`failed to load ${url}: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      });
      fetched.set(url.href, bytes);
      // A failed fetch must not poison later attempts.
      bytes.catch(() => fetched.delete(url.href));
    }
    return memory_storage(await bytes);
  },
};

interface FileHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<{ size: number }>;
  close(): Promise<void>;
}

interface GetBuiltinModule {
  (id: "node:fs/promises"): {
    open(path: URL, flags: "r"): Promise<FileHandle>;
  };
}

interface NodeProcess {
  getBuiltinModule?: GetBuiltinModule;
}

// Node reads the packaged file on demand, so a machine only pages in the
// blocks the guest touches.
function node(getBuiltinModule: GetBuiltinModule): Platform {
  const { open } = getBuiltinModule("node:fs/promises");
  return {
    async open_image(url) {
      const handle = await open(url, "r");
      try {
        const { size } = await handle.stat();
        return {
          capacity: size,
          async read(offset, target) {
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
          },
          close: () => handle.close(),
        };
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
