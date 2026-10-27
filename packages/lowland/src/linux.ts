// SPDX-License-Identifier: MIT

import {
  bootMachine,
  entropyDevice,
  type FS,
  type Machine,
  type Network,
  type NetworkAttachment,
} from "./machine/index.ts";
import type { MachinePlugin, MachinePluginInput } from "./machine/plugin.ts";
import {
  guestAgent,
  type ChildProcess,
  type ExecOptions,
  type FileSystem,
  type GuestAgent,
  type Mount,
  type RunResult,
} from "./guest/index.ts";
import { image_mount, type ImageSource } from "./image/source.ts";

/** A disk image attached to a machine and mounted at a guest path. */
export interface DiskOptions {
  /**
   * A filesystem image, as any source `rootImage()` from `lowland/image`
   * accepts: a file path in
   * Node, a URL, a file handle, bytes, a blob, or a response. A writable
   * disk needs a path, a file handle, or bytes.
   */
  source: ImageSource;
  /** The absolute guest path to mount the disk at. */
  path: string;
  /**
   * Attaches the disk read-only. Defaults to `false`, so writes to an ext4
   * disk persist in its source. The kernel mounts an EROFS disk read-only
   * either way.
   */
  readOnly?: boolean;
}

/** A filesystem shared into a machine and mounted at a guest path. */
export interface MountOptions {
  /**
   * The filesystem to share, such as a `NodeFS` from `lowland/node` for a
   * host directory, or a `BrowserFS` from `lowland/browser` for the origin
   * private file system.
   */
  source: FS<object, any>;
  /** The absolute guest path to mount the filesystem at. */
  path: string;
  /**
   * Mounts the filesystem read-only in the guest. Defaults to `false`. The
   * source can enforce this itself too, as `NodeFS` does with its own
   * `readOnly` option.
   */
  readOnly?: boolean;
}

/** The configuration of a machine created by `Linux.create()`. */
export interface LinuxOptions {
  /**
   * The root: `rootImage()` from `lowland/image` for the canonical image, or
   * your own image as any source `rootImage()` accepts, which is mounted
   * read-only beneath a temporary overlay, so it never changes. A mount entry
   * at `/` of your own is used as given.
   *
   * There is no default, so an application that boots its own image never
   * bundles the canonical one: only importing `lowland/image` does.
   */
  image: Mount | ImageSource;
  /** Disk images to attach and mount, in order. */
  disks?: readonly DiskOptions[];
  /** Filesystems to share and mount, in order. */
  mounts?: readonly MountOptions[];
  /**
   * A network from `createNetwork()` in `lowland/machine` to attach the
   * machine to. The caller owns the network and closes it.
   */
  network?: Network;
  /** Virtual CPUs to boot. Defaults to 1. */
  cpus?: number;
  /** Further plugins, configured after the machine's own devices. */
  plugins?: readonly MachinePluginInput[];
}

function valid_guest_path(path: string) {
  return (
    path.startsWith("/") &&
    path !== "/" &&
    path
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function check_guest_path(kind: string, path: string) {
  if (!valid_guest_path(path)) {
    throw new TypeError(`${kind} paths must be absolute, normalized, and not /: ${path}`);
  }
}

/** The root mount for `LinuxOptions.image`. */
function root_mount(image: Mount | ImageSource): Mount {
  // A mount entry has a path; no image source does.
  if (typeof (image as Partial<Mount>).path !== "string") return image_mount(image as ImageSource);
  const mount = image as Mount;
  if (mount.path !== "/") throw new TypeError(`the image must be mounted at /, not ${mount.path}`);
  return mount;
}

// Scratch space in memory, whatever the root is.
const DEFAULT_MOUNTS: readonly Mount[] = [
  { path: "/run", type: "tmpfs", options: "mode=0755" },
  { path: "/tmp", type: "tmpfs", options: "mode=1777" },
];

/**
 * A Linux machine with the canonical kernel, guest agent, and an image.
 *
 * Each value owns one live machine. Close it with `await using`, or with
 * `close()` when its disks need no flushing.
 *
 * @example Run a command
 * ```ts
 * import { Linux } from "lowland";
 * import { rootImage } from "lowland/image";
 *
 * await using linux = await Linux.create({ image: rootImage() });
 * const result = await linux.run(["uname", "-a"]);
 * console.log(new TextDecoder().decode(result.stdout));
 * ```
 */
export class Linux implements AsyncDisposable {
  readonly #machine: Machine;
  readonly #guest: GuestAgent;
  readonly #network: NetworkAttachment | undefined;
  readonly #disk_paths: readonly string[];
  readonly #children = new Set<ChildProcess>();

  private constructor(
    machine: Machine,
    guest: GuestAgent,
    network: NetworkAttachment | undefined,
    disk_paths: readonly string[],
  ) {
    this.#machine = machine;
    this.#guest = guest;
    this.#network = network;
    this.#disk_paths = disk_paths;
  }

  /** Boots a machine and mounts its disks and filesystems. */
  static async create(options: LinuxOptions): Promise<Linux> {
    if (options?.image === undefined) {
      throw new TypeError("Linux.create() needs an image, such as rootImage() from lowland/image");
    }
    const root = root_mount(options.image);
    const disks = options.disks ?? [];
    const mounts = options.mounts ?? [];
    const guest_paths = new Set<string>();
    for (const [kind, entries] of [
      ["disk", disks],
      ["mount", mounts],
    ] as const) {
      for (const { path } of entries) {
        check_guest_path(kind, path);
        if (guest_paths.has(path)) throw new TypeError(`two mounts target ${path}`);
        guest_paths.add(path);
      }
    }

    const guest = guestAgent({
      mounts: [
        root,
        ...DEFAULT_MOUNTS,
        ...disks.map((disk): Mount => ({
          path: disk.path,
          source: disk.source,
          mode: disk.readOnly ? "ro" : "rw",
        })),
        ...mounts.map((mount): Mount => ({
          path: mount.path,
          source: mount.source,
          mode: mount.readOnly ? "ro" : "rw",
        })),
      ],
    });
    const network = options.network?.attach();
    const machine = await bootMachine({
      cpus: options.cpus ?? 1,
      plugins: [
        guest,
        entropyDevice(),
        ...(network ? [network] : []),
        ...(options.plugins ?? []),
      ],
    });
    return new Linux(
      machine,
      guest,
      network,
      disks.map((disk) => disk.path),
    );
  }

  /** File operations in the guest. */
  get fs(): FileSystem {
    return this.#guest.fs;
  }

  /**
   * The machine's attachment to `options.network`, for connecting to ports
   * in the guest, or `undefined` without a network.
   */
  get network(): NetworkAttachment | undefined {
    return this.#network;
  }

  /** Settles when the machine closes, rejecting if it failed unexpectedly. */
  get closed(): Promise<void> {
    return this.#machine.closed;
  }

  /**
   * Runs a command and collects its status, stdout, and stderr. It runs in
   * `/` unless `options.cwd` says otherwise. With `options.terminal`, it
   * runs on a guest terminal and its standard error is part of `stdout`.
   */
  run(argv: readonly string[], options?: ExecOptions): Promise<RunResult> {
    return this.#guest.run(argv, { ...options, cwd: options?.cwd ?? "/" });
  }

  /**
   * Starts a command with streaming standard I/O. It runs in `/` unless
   * `options.cwd` says otherwise.
   *
   * With `options.terminal`, the command runs on a guest terminal instead of
   * pipes, leading its own session, so a shell gets job control. Its
   * `stdin` takes keys, such as `\x03` for Ctrl-C, `stdout` shows the
   * terminal's output, standard error included, and `resize()` changes the
   * terminal's size.
   *
   * @example Connect a shell to a terminal emulator in a page
   * ```ts
   * const shell = await linux.spawn(["sh"], {
   *   terminal: { rows: term.rows, columns: term.cols },
   * });
   * void shell.stdout.pipeTo(new WritableStream({ write: (bytes) => term.write(bytes) }));
   * const keys = shell.stdin.getWriter();
   * term.onData((data) => void keys.write(new TextEncoder().encode(data)));
   * term.onResize(({ rows, cols }) => void shell.resize({ rows, columns: cols }));
   * await shell.status;
   * ```
   */
  async spawn(argv: readonly string[], options?: ExecOptions): Promise<ChildProcess> {
    const child = await this.#guest.exec(argv, { ...options, cwd: options?.cwd ?? "/" });
    this.#children.add(child);
    void child.status.finally(() => this.#children.delete(child)).catch(() => {});
    return child;
  }

  /**
   * Shuts the machine down immediately, without waiting. Writes to disks
   * that the guest has not flushed yet are lost, so prefer `await using`
   * when disks are attached.
   */
  close(): void {
    this.#machine.close();
  }

  /**
   * Kills the commands started with `spawn()`, flushes and unmounts the
   * disks so their writes reach the files, and waits for the machine to shut
   * down. Rejects, after shutting down, if the disks could not be flushed.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    let flushed = true;
    let failure: unknown;
    try {
      // Running commands keep disks busy, and the machine is going away.
      await Promise.all(
        [...this.#children].map(async (child) => {
          await child.kill("SIGKILL").catch(() => {});
          await child.status.catch(() => {});
        }),
      );
      if (this.#disk_paths.length) {
        // sync needs no process slot and flushes even through file handles
        // that are still open, which would make the unmounts below fail.
        try {
          await this.#guest.fs.sync();
        } catch (error) {
          flushed = false;
          failure = error;
        }
        for (const path of this.#disk_paths.toReversed()) {
          await this.#guest.unmount(path).catch(() => {});
        }
      }
    } finally {
      await this.#machine[Symbol.asyncDispose]();
    }
    if (!flushed) throw new Error("could not flush the disks", { cause: failure });
  }
}
