// SPDX-License-Identifier: MIT

import { blockDevice, type BlockDeviceStorage } from "@lowland/kernel";
import type { MachinePlugin } from "@lowland/kernel/plugin";
import { file_storage, platform, type ImageFileHandle } from "./platform.ts";
import { check_bytes } from "./validate.ts";

/** @internal An image source after string resolution. */
export type ResolvedSource =
  | { kind: "path"; path: string | URL }
  | { kind: "url"; url: URL }
  | { kind: "handle"; handle: ImageFileHandle }
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "blob"; blob: Blob | Response };

function memory_storage(bytes: Uint8Array, writable: boolean): BlockDeviceStorage {
  const storage: BlockDeviceStorage = {
    capacity: bytes.byteLength,
    read(offset, target) {
      const source = bytes.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  };
  if (writable) {
    storage.write = (offset, data) => {
      const length = Math.max(0, Math.min(data.byteLength, bytes.byteLength - offset));
      bytes.set(data.subarray(0, length), offset);
      return length;
    };
    storage.flush = () => {};
  }
  return storage;
}

// Browsers fetch each image once and serve every machine from that copy.
const fetched = new Map<string, Promise<Uint8Array>>();

/** @internal Fetches and validates an image, sharing one download per URL. */
export function fetch_image(url: URL): Promise<Uint8Array> {
  let bytes = fetched.get(url.href);
  if (!bytes) {
    bytes = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`failed to load ${url}: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      check_bytes(`${url} did not return`, bytes, response.headers.get("content-type"));
      return bytes;
    });
    fetched.set(url.href, bytes);
    // A failed fetch must not poison later attempts.
    bytes.catch(() => fetched.delete(url.href));
  }
  return bytes;
}

async function read_blob(blob: Blob | Response) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const type = blob instanceof Response ? blob.headers.get("content-type") : blob.type;
  check_bytes(blob instanceof Response ? "the response is not" : "the blob is not", bytes, type);
  return bytes;
}

/** @internal Attaches an image as a block device, writable only when asked. */
export function image_plugin(source: ResolvedSource, writable: boolean): MachinePlugin {
  // A blob or response is read once, and a response body cannot be read twice.
  let blob_bytes: Promise<Uint8Array> | undefined;

  async function open(): Promise<BlockDeviceStorage> {
    switch (source.kind) {
      case "path":
        return platform.open_path(source.path, writable);
      case "url":
        return memory_storage(await fetch_image(source.url), false);
      case "handle":
        // The caller opened the handle, so the caller closes it.
        return file_storage("the file handle is not", source.handle, writable);
      case "bytes":
        check_bytes("the image bytes are not", source.bytes);
        return memory_storage(source.bytes, writable);
      case "blob":
        blob_bytes ??= read_blob(source.blob);
        return memory_storage(await blob_bytes, false);
    }
  }

  return {
    async configure(setup) {
      setup.devices.add(blockDevice(await open()));
    },
  };
}
