// SPDX-License-Identifier: MIT

import {
  blockDevice,
  bootMachine,
  type BlockStorage,
  entropyDevice,
  fileSystemDevice,
} from "@lowland/kernel";
import { createNetwork, guestAgent } from "@lowland/guest";
import { NodeFS } from "@lowland/guest/node";
import { resolve4 } from "node:dns/promises";
import { once } from "node:events";
import { cp, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, posix, resolve } from "node:path";
import { Duplex } from "node:stream";
import { rootImage } from "./index.ts";

/** The repository that package names are resolved from. */
const REPOSITORY = "http://assets.low.land/apk/wasm32/Packages.adb";

/** The filesystem formats the builder image can produce, default first. */
const FORMATS = ["erofs", "ext4"] as const;

/** A filesystem format that `buildImage()` can produce. */
export type ImageFormat = (typeof FORMATS)[number];

/** A host file or directory to copy into the image, with an optional octal mode such as `"0755"`. */
export type ImageFile = string | { source: string; mode?: string };

/** The contents and encoding of an image built by `buildImage()`. */
export interface BuildImageOptions {
  /**
   * apk packages to install. Names such as `"curl"` resolve from the public
   * Lowland repository. Values that end in `.apk` or contain a slash are paths
   * to local package files, which are installed without signature checks.
   */
  packages: readonly string[];
  /** Host files to copy into the image, keyed by absolute guest path. */
  files?: Readonly<Record<string, ImageFile>>;
  /** Symbolic links to create, keyed by absolute guest path, with their targets as values. */
  links?: Readonly<Record<string, string>>;
  /**
   * The filesystem format. Defaults to `"erofs"`, an immutable image that the
   * guest agent mounts read-only. Use `"ext4"` for a writable image.
   */
  format?: ImageFormat;
  /** The filesystem label. Defaults to `"LOWLAND_ROOT"`, the label the guest agent boots. */
  label?: string;
  /**
   * The image size in bytes, or with a `K`, `M`, or `G` suffix. Defaults to
   * `"256M"`. An EROFS image is truncated to its encoded size, so for EROFS
   * this is only the largest image the build may produce.
   */
  size?: number | string;
  /** The path of the image file to write. */
  output: string;
}

function valid_path(path: string) {
  return (
    path.startsWith("/") &&
    path !== "/" &&
    path
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function parse_size(size: number | string) {
  const match = /^(\d+)([KMG]?)$/.exec(String(size));
  const unit = { "": 1, K: 2 ** 10, M: 2 ** 20, G: 2 ** 30 }[match?.[2] ?? ""];
  const bytes = match && unit ? Number(match[1]) * unit : NaN;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % 512 !== 0) {
    throw new TypeError(`image size must be a positive multiple of 512 bytes, got ${size}`);
  }
  return bytes;
}

function is_local_package(name: string) {
  return name.endsWith(".apk") || name.includes("/");
}

function output_storage(handle: Awaited<ReturnType<typeof open>>, capacity: number) {
  return {
    capacity,
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
    async write(offset, data) {
      let total = 0;
      while (total < data.byteLength) {
        const { bytesWritten } = await handle.write(
          data,
          total,
          data.byteLength - total,
          offset + total,
        );
        total += bytesWritten;
      }
      return total;
    },
    flush: () => handle.datasync(),
  } satisfies BlockStorage;
}

// The superblock at byte 1024 records the block size as a power of two and
// the block count of the encoded image.
async function erofs_size(handle: Awaited<ReturnType<typeof open>>) {
  const superblock = new DataView(new ArrayBuffer(64));
  await handle.read(new Uint8Array(superblock.buffer), 0, superblock.byteLength, 1024);
  if (superblock.getUint32(0, true) !== 0xe0f5e1e2) throw new Error("builder wrote no EROFS image");
  return superblock.getUint32(36, true) * 2 ** superblock.getUint8(12);
}

function node_network() {
  return createNetwork({
    async connectTcp(session) {
      const socket = createConnection({
        host: session.target.hostname,
        port: session.target.port,
        signal: session.signal,
      });
      await once(socket, "connect");
      const streams = Duplex.toWeb(socket);
      await Promise.all([
        session.readable.pipeTo(streams.writable as WritableStream<Uint8Array>),
        (streams.readable as ReadableStream<Uint8Array>).pipeTo(session.writable),
      ]);
    },
    resolveDns: resolve4,
  });
}

/**
 * Builds a filesystem image from apk packages and host files.
 *
 * The build runs in a Lowland machine that boots a builder image shipped in
 * this package. It formats the output, installs the packages, copies the
 * files, creates the links, and adds the directories the guest agent needs.
 * The result boots with `@lowland/guest` when it keeps the default label.
 * The machine uses the host network only when a package is named rather than
 * given as a local file. This module requires Node.
 *
 * @example Build an image with curl and an application
 * ```ts
 * await buildImage({
 *   packages: ["curl"],
 *   files: { "/usr/local/bin/app": { source: "./build/app", mode: "0755" } },
 *   output: "app.erofs",
 * });
 * ```
 */
export async function buildImage(options: BuildImageOptions): Promise<void> {
  const format = options.format ?? FORMATS[0];
  if (!FORMATS.includes(format)) {
    throw new TypeError(
      `unsupported image format ${JSON.stringify(format)}, expected one of: ${FORMATS.join(", ")}`,
    );
  }
  const label = options.label ?? "LOWLAND_ROOT";
  if (!/^[A-Za-z0-9._-]{1,15}$/.test(label)) {
    throw new TypeError(
      "image label must contain 1 to 15 ASCII letters, digits, dots, underscores, or hyphens",
    );
  }
  const size = parse_size(options.size ?? "256M");
  if (options.packages.length === 0) throw new TypeError("an image requires at least one package");
  const files = Object.entries(options.files ?? {});
  const links = Object.entries(options.links ?? {});
  for (const [path] of [...files, ...links]) {
    if (!valid_path(path))
      throw new TypeError(`image paths must be absolute and normalized: ${path}`);
    if (options.files?.[path] !== undefined && options.links?.[path] !== undefined) {
      throw new TypeError(`image paths cannot be both files and links: ${path}`);
    }
  }
  for (const [path, file] of files) {
    const mode = typeof file === "string" ? undefined : file.mode;
    if (mode !== undefined && !/^0?[0-7]{3,4}$/.test(mode)) {
      throw new TypeError(`image file modes must be octal strings: ${path}`);
    }
  }

  // Inputs are staged into one read-only share so arbitrary host paths reach
  // the guest under names that need no quoting.
  const input = await mkdtemp(join(tmpdir(), "lowland-image-"));
  const output = resolve(options.output);
  let built = false;
  try {
    const args = [
      "lowland-build-image",
      "--format",
      format,
      "--label",
      label,
      "--input",
      "/tmp/input",
    ];
    const operations: string[] = [];
    let local = false;
    let remote = false;
    for (const [index, name] of options.packages.entries()) {
      if (is_local_package(name)) {
        const staged = posix.join("packages", `${index}-${basename(name)}`);
        await cp(await realpath(name), join(input, staged));
        operations.push("--local", staged);
        local = true;
      } else {
        operations.push("--package", name);
        remote = true;
      }
    }
    for (const [index, [path, file]] of files.entries()) {
      const source = typeof file === "string" ? file : file.source;
      const mode = typeof file === "string" ? undefined : file.mode;
      const staged = posix.join("files", String(index));
      await cp(await realpath(source), join(input, staged), {
        recursive: true,
        verbatimSymlinks: true,
      });
      operations.push("--file", path, staged, mode ?? "-");
    }
    for (const [path, target] of links) operations.push("--link", path, target);
    if (remote) args.push("--repository", REPOSITORY);
    if (local) args.push("--allow-untrusted");
    args.push(...operations);

    const handle = await open(output, "w+");
    try {
      await handle.truncate(size);
      const guest = guestAgent();
      const network = remote ? node_network() : undefined;
      try {
        await using machine = await bootMachine({
          cpus: 1,
          plugins: [
            rootImage(new URL("../builder.erofs", import.meta.url)),
            blockDevice(output_storage(handle, size)),
            fileSystemDevice(new NodeFS(input, { readOnly: true }), { tag: "input" }),
            entropyDevice(),
            guest,
            ...(network ? [network.attach(guest)] : []),
          ],
        });
        await guest.fs.mkdir("/tmp/input");
        await guest.mount("input", "/tmp/input", { type: "virtiofs" });
        const result = await guest.run(args);
        if (!result.status.success) {
          const decoder = new TextDecoder();
          const log = decoder.decode(result.stdout) + decoder.decode(result.stderr);
          throw new Error(`image build failed:\n${log.trimEnd()}`);
        }
      } finally {
        network?.close();
      }
      if (format === "erofs") await handle.truncate(await erofs_size(handle));
      await handle.datasync();
      built = true;
    } finally {
      await handle.close();
    }
  } finally {
    await rm(input, { recursive: true, force: true });
    if (!built) await rm(output, { force: true });
  }
}
