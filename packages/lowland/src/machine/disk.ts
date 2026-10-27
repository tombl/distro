// SPDX-License-Identifier: MIT

// Disk sources: where a block device's bytes come from. This knows nothing
// about filesystems. Its only checks are ones that hold for any disk: an
// error page is not a disk, and a disk is whole sectors.

import type { BlockStorage } from "./virtio/block.ts";

/**
 * The parts of a Node `FileHandle` that a disk needs.
 *
 * `write()` and `datasync()` are only called for writable disks.
 */
export interface DiskFileHandle {
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

/**
 * Where a disk's bytes come from.
 *
 * A string is a file path in Node and a URL, relative to the page, in
 * browsers. A `URL` with the `file:` scheme is a path, and any other `URL` is
 * fetched. Byte arrays, blobs, and responses hold the whole disk in memory.
 * A `BlockStorage` is used as it is.
 */
export type DiskSource =
  | string
  | URL
  | DiskFileHandle
  | Uint8Array
  | ArrayBuffer
  | Blob
  | Response
  | BlockStorage;

/** Options for {@link diskStorage}. */
export interface DiskStorageOptions {
  /**
   * Lets the guest write to the disk. A path is opened for reading and
   * writing, a file handle must already be open for writing, byte arrays are
   * modified in place, and block storage must implement `write()`. Fetched
   * disks, blobs, and responses cannot be writable. Otherwise the disk is
   * read-only, whatever its source allows.
   */
  writable: boolean;
}

// Block devices count their capacity in whole sectors, and dropping a partial
// final sector would truncate whatever the disk holds.
const SECTOR_SIZE = 512;

/** Throws if a disk of `size` bytes, served as `content_type`, is not a disk. */
function check_disk(subject: string, size: number, content_type?: string | null) {
  const type = content_type?.split(";")[0]?.trim().toLowerCase() || undefined;
  const got = type ? `${type}, ${size} bytes` : `${size} bytes`;
  // A dev server's HTML fallback, served in place of a missing asset.
  if (type === "text/html") throw new Error(`${subject} a disk image: got ${got}`);
  if (size % SECTOR_SIZE !== 0) {
    throw new Error(
      `${subject} a disk image: got ${got}, which is not a multiple of ${SECTOR_SIZE}`,
    );
  }
}

function memory_storage(bytes: Uint8Array, writable: boolean): BlockStorage {
  const storage: BlockStorage = {
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

/** Wraps an open file, named `name` in errors, in block storage. */
async function file_storage(
  name: string,
  handle: DiskFileHandle,
  writable: boolean,
): Promise<BlockStorage> {
  const { size } = await handle.stat();
  check_disk(`${name} is not`, size);
  const storage: BlockStorage = {
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
  };
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

/** Block storage that hides the writes of the storage it wraps. */
function read_only_storage(storage: BlockStorage): BlockStorage {
  const view: BlockStorage = {
    capacity: storage.capacity,
    read: (offset, target) => storage.read(offset, target),
  };
  if (storage.readv) view.readv = (offset, targets) => storage.readv!(offset, targets);
  if (storage.close) view.close = () => storage.close!();
  return view;
}

// Browsers fetch each disk once and serve every machine from that copy.
const fetched = new Map<string, Promise<Uint8Array>>();

function fetch_disk(url: URL): Promise<Uint8Array> {
  let bytes = fetched.get(url.href);
  if (!bytes) {
    bytes = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`failed to load ${url}: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      check_disk(`${url} did not return`, bytes.byteLength, response.headers.get("content-type"));
      return bytes;
    });
    fetched.set(url.href, bytes);
    // A failed fetch must not poison later attempts.
    bytes.catch(() => fetched.delete(url.href));
  }
  return bytes;
}

// A blob or response is read once, and a response body cannot be read twice.
const blobs = new WeakMap<Blob | Response, Promise<Uint8Array>>();

function read_blob(blob: Blob | Response): Promise<Uint8Array> {
  let bytes = blobs.get(blob);
  if (!bytes) {
    bytes = blob.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      const type = blob instanceof Response ? blob.headers.get("content-type") : blob.type;
      check_disk(
        blob instanceof Response ? "the response is not" : "the blob is not",
        bytes.byteLength,
        type,
      );
      return bytes;
    });
    blobs.set(blob, bytes);
  }
  return bytes;
}

interface GetBuiltinModule {
  (id: "node:fs/promises"): {
    open(
      path: string | URL,
      flags: "r" | "r+",
    ): Promise<DiskFileHandle & { close(): Promise<void> }>;
  };
}

const getBuiltinModule = (globalThis as { process?: { getBuiltinModule?: GetBuiltinModule } })
  .process?.getBuiltinModule;

/** Opens a file path, which only Node can, as block storage that closes the file. */
async function path_storage(path: string | URL, writable: boolean): Promise<BlockStorage> {
  if (!getBuiltinModule) throw new Error(`cannot open ${path}: files are only available in Node`);
  const handle = await getBuiltinModule("node:fs/promises").open(path, writable ? "r+" : "r");
  try {
    const name = path instanceof URL ? decodeURIComponent(path.pathname) : path;
    const storage = await file_storage(name, handle, writable);
    storage.close = () => handle.close();
    return storage;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function is_block_storage(source: object): source is BlockStorage {
  return typeof (source as Partial<BlockStorage>).read === "function" && "capacity" in source;
}

function is_file_handle(source: object): source is DiskFileHandle {
  return typeof (source as Partial<DiskFileHandle>).read === "function" && "stat" in source;
}

/**
 * Opens a disk source as block storage for `blockDevice()`.
 *
 * Every disk must be whole 512-byte sectors, and a fetched disk, blob, or
 * response served as `text/html`, such as a dev server's fallback page, is
 * rejected. Nothing else about the contents is checked. Node reads files on
 * demand, so a machine only loads the blocks the guest touches, and closes
 * the file with the device. Fetched disks are downloaded once and shared
 * between machines. A file handle stays open after the machines close.
 *
 * @example Serve a writable disk image from a file
 * ```ts
 * blockDevice(await diskStorage("data.ext4", { writable: true }), { serial: "data" })
 * ```
 */
export async function diskStorage(
  source: DiskSource,
  options: DiskStorageOptions,
): Promise<BlockStorage> {
  const { writable } = options;
  if (typeof source === "string") {
    if (!getBuiltinModule) source = new URL(source, globalThis.location?.href);
    else return path_storage(source, writable);
  }
  if (source instanceof URL) {
    if (source.protocol === "file:") return path_storage(source, writable);
    if (writable) throw new TypeError(`a fetched disk cannot be writable: ${source}`);
    return memory_storage(await fetch_disk(source), false);
  }
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    check_disk("the bytes are not", bytes.byteLength);
    return memory_storage(bytes, writable);
  }
  if (source instanceof Blob || source instanceof Response) {
    if (writable) throw new TypeError("a blob or response cannot be a writable disk");
    return memory_storage(await read_blob(source), false);
  }
  if (is_block_storage(source)) {
    check_disk("the block storage is not", source.capacity);
    if (!writable) return read_only_storage(source);
    if (!source.write) throw new TypeError("writable block storage must implement write()");
    return source;
  }
  if (is_file_handle(source)) return file_storage("the file handle", source, writable);
  throw new TypeError(
    "a disk source must be a path, URL, file handle, bytes, blob, response, or block storage",
  );
}
