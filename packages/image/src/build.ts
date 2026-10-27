// SPDX-License-Identifier: MIT

import { blockDevice, bootMachine, type BlockStorage, entropyDevice } from "@lowland/kernel";
import { createNetwork, guestAgent, type Network } from "@lowland/guest";
import { NodeFS } from "@lowland/guest/node";
import { randomUUID } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { once } from "node:events";
import { chmod, cp, lstat, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { Duplex } from "node:stream";

/** The repository that package names are resolved from. */
const REPOSITORY = "http://assets.low.land/apk/wasm32/Packages.adb";

/** The filesystem formats the builder image can produce, default first. */
const FORMATS = ["erofs", "ext4"] as const;

/** A filesystem format that `buildImage()` can produce. */
export type ImageFormat = (typeof FORMATS)[number];

/** The EROFS compressions the builder image can apply, default first. */
const COMPRESSIONS = ["deflate", "lzma", "none"] as const;

/** An EROFS compression that `buildImage()` can apply. */
export type ImageCompression = (typeof COMPRESSIONS)[number];

/** A host file or directory to copy into the image, with an optional octal mode such as `"0755"`. */
export type ImageFile = string | { source: string; mode?: string };

/** The contents and encoding of an image built by `buildImage()`. */
export interface BuildImageOptions {
  /**
   * apk packages to install. Names such as `"curl"` resolve from the public
   * Lowland repository, which must sign them. Values that end in `.apk` or
   * contain a slash are paths to local package files, which are trusted
   * because you supplied them and are installed without signature checks.
   * Local packages install after the named ones and never use the network,
   * so their dependencies must be named or local packages too.
   */
  packages: readonly string[];
  /**
   * Host files to copy into the image, keyed by absolute guest path. A mode
   * is applied exactly, setuid, setgid, and sticky bits included; without
   * one an entry keeps its host mode and gains owner write. A directory onto
   * an existing directory, such as `/etc` or `/usr`, merges its contents into
   * it; its mode, if given, applies to the destination directory alone, and a
   * merge otherwise keeps the existing directory's mode. Entries apply in
   * path order, so a file inside a directory entry overrides what it copied.
   */
  files?: Readonly<Record<string, ImageFile>>;
  /** Symbolic links to create, keyed by absolute guest path, with their targets as values. */
  links?: Readonly<Record<string, string>>;
  /**
   * The filesystem format. Defaults to `"erofs"`, an immutable image that the
   * guest agent mounts read-only. Use `"ext4"` for a writable image.
   */
  format?: ImageFormat;
  /**
   * How EROFS file data is compressed. Defaults to `"deflate"`, which
   * typically shrinks an image 2 to 3 times for a modest cost on reads.
   * `"lzma"` is about 14% smaller again but reads about half as fast, and
   * `"none"` stores data as is. ext4 images are never compressed and ignore
   * this option.
   */
  compression?: ImageCompression;
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

// An apk dependency atom: a name, optionally with a provider prefix such as
// `cmd:` and a version constraint such as `>=1.7`. A leading hyphen would be
// read as an apk option.
function valid_package_name(name: string) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.+:-]*(?:(?:[<>]=?|=|~|=~|>~|<~)[A-Za-z0-9_.+-]+)?$/.test(name);
}

// Staged copies must be removable afterwards, so a read-only source directory
// gains owner write in its copy. Symbolic links are left as they are.
async function make_owner_writable(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) return;
  await chmod(path, stats.mode | 0o200);
  if (stats.isDirectory()) {
    for (const entry of await readdir(path)) await make_owner_writable(join(path, entry));
  }
}

// Runs every cleanup step even if an earlier one fails, collecting failures
// after any error from the build itself.
async function attempt(errors: unknown[], step: () => unknown) {
  try {
    await step();
  } catch (error) {
    errors.push(error);
  }
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

/** @internal Where named packages come from: the public repository, or a test fixture. */
export interface PackageRepository {
  url: string;
  network(): Network;
}

const PUBLIC_REPOSITORY: PackageRepository = { url: REPOSITORY, network: node_network };

/**
 * Builds a filesystem image from apk packages and host files.
 *
 * The build runs in a Lowland machine that boots a builder image shipped in
 * this package. It formats the output, installs the packages, copies the
 * files, creates the links, and adds the standard mount points. Boot the
 * result with `rootImage()`, or mount it with `@lowland/guest`.
 * The machine uses the host network only when a package is named rather than
 * given as a local file. Named packages must be signed by the public
 * repository, while local package files are trusted as given. The output is
 * written to a temporary file beside it and renamed into place, so a failed
 * build leaves any existing output untouched. This module requires Node.
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
export function buildImage(options: BuildImageOptions): Promise<void> {
  return build_image(options, PUBLIC_REPOSITORY);
}

/** @internal `buildImage()` with named packages from `repository`. */
export async function build_image(
  options: BuildImageOptions,
  repository: PackageRepository,
): Promise<void> {
  const format = options.format ?? FORMATS[0];
  if (!FORMATS.includes(format)) {
    throw new TypeError(
      `unsupported image format ${JSON.stringify(format)}, expected one of: ${FORMATS.join(", ")}`,
    );
  }
  const compression = options.compression ?? COMPRESSIONS[0];
  if (!COMPRESSIONS.includes(compression)) {
    throw new TypeError(
      `unsupported image compression ${JSON.stringify(compression)}, expected one of: ${COMPRESSIONS.join(", ")}`,
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
  for (const name of options.packages) {
    if (!is_local_package(name) && !valid_package_name(name)) {
      throw new TypeError(`invalid package name: ${JSON.stringify(name)}`);
    }
  }
  // Sorted like mkImage's attribute names, so parents apply before children.
  const files = Object.entries(options.files ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
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

  // Inputs are staged into one read-only share under generated names, so
  // arbitrary host paths reach the guest without quoting.
  const input = await mkdtemp(join(tmpdir(), "lowland-image-"));
  const output = resolve(options.output);
  const temporary = join(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let built = false;
  const errors: unknown[] = [];
  try {
    const args = [
      "lowland-build-image",
      "--format",
      format,
      "--compression",
      compression,
      "--label",
      label,
      "--input",
      "/tmp/input",
    ];
    const operations: string[] = [];
    let remote = false;
    for (const [index, name] of options.packages.entries()) {
      if (is_local_package(name)) {
        const staged = posix.join("packages", `${index}.apk`);
        await cp(await realpath(name), join(input, staged));
        await make_owner_writable(join(input, staged));
        operations.push("--local", staged);
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
      await make_owner_writable(join(input, staged));
      operations.push("--file", path, staged, mode ?? "-");
    }
    for (const [path, target] of links) operations.push("--link", path, target);
    if (remote) args.push("--repository", repository.url);
    args.push(...operations);

    handle = await open(temporary, "wx+");
    await handle.truncate(size);
    const guest = guestAgent({
      mounts: [
        {
          path: "/",
          source: new URL("../builder.erofs", import.meta.url),
          type: "erofs",
          mode: "overlay",
        },
        // The build stages EROFS trees in memory, as the builder expects.
        { path: "/tmp", type: "tmpfs", options: "mode=1777" },
        { path: "/tmp/input", source: new NodeFS(input, { readOnly: true }), mode: "ro" },
      ],
    });
    const network = remote ? repository.network() : undefined;
    try {
      await using machine = await bootMachine({
        cpus: 1,
        plugins: [
          guest,
          // The script writes to the machine's only writable block device.
          blockDevice(output_storage(handle, size)),
          entropyDevice(),
          ...(network ? [network.attach(guest)] : []),
        ],
      });
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
    await handle.close();
    handle = undefined;
    await rename(temporary, output);
    built = true;
  } catch (error) {
    errors.push(error);
  }
  await attempt(errors, () => handle?.close());
  await attempt(errors, () => rm(input, { recursive: true, force: true }));
  if (!built) await attempt(errors, () => rm(temporary, { force: true }));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const first = errors[0] instanceof Error ? errors[0].message : String(errors[0]);
    throw new AggregateError(errors, `${first}\n(cleaning up also failed)`);
  }
}
