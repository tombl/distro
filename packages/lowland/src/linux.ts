// SPDX-License-Identifier: MIT

import {
  bootMachine,
  entropyDevice,
  type FS,
  type Machine,
  type MachineExit,
  type Network,
  type NetworkAttachment,
  type PowerOptions,
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
 * Each value owns one live machine. Shut it down with `await using` or
 * `shutdown()`: the guest ends its processes, then syncs and unmounts its
 * filesystems, so writes to disks reach their files.
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

  private constructor(machine: Machine, guest: GuestAgent, network: NetworkAttachment | undefined) {
    this.#machine = machine;
    this.#guest = guest;
    this.#network = network;
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
      plugins: [guest, entropyDevice(), ...(network ? [network] : []), ...(options.plugins ?? [])],
    });
    return new Linux(machine, guest, network);
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

  /** Settles once the machine has ended, and never rejects. */
  get exited(): Promise<MachineExit> {
    return this.#machine.exited;
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
    return this.#guest.exec(argv, { ...options, cwd: options?.cwd ?? "/" });
  }

  /**
   * Powers the machine off: the guest ends its processes, syncs and
   * unmounts its filesystems, then powers off. Kills the machine if it has
   * not ended after `timeoutMs`, 30 000 ms by default.
   */
  shutdown(options?: PowerOptions): Promise<MachineExit> {
    return this.#machine.shutdown(options);
  }

  /** Reboots the guest, and resolves once it has booted again. */
  reboot(options?: PowerOptions): Promise<void> {
    return this.#machine.reboot(options);
  }

  /** Stops the machine at once. Writes the guest has not flushed are lost. */
  kill(): void {
    this.#machine.kill();
  }

  /** `shutdown()`, with its default timeout. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.#machine[Symbol.asyncDispose]();
  }
}
