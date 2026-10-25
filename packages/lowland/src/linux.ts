// SPDX-License-Identifier: MIT

import {
  bootMachine,
  entropyDevice,
  fileSystemDevice,
  type FS,
  type Machine,
} from "@lowland/kernel";
import { machinePlugin, type MachinePlugin, type MachinePluginInput } from "@lowland/kernel/plugin";
import {
  guestAgent,
  MountFlags,
  type ChildProcess,
  type ExecOptions,
  type FileSystem,
  type GuestAgent,
  type Network,
  type NetworkAttachment,
  type RunResult,
} from "@lowland/guest";
import { rootImage, type ImageSource } from "@lowland/image";

/** A disk image attached to a machine and mounted at a guest path. */
export interface DiskOptions {
  /**
   * An EROFS or ext4 image, as any source `rootImage()` accepts: a file path
   * in Node, a URL, a file handle, bytes, a blob, or a response. A writable
   * disk needs a path, a file handle, or bytes.
   *
   * The disk must not be labeled `LOWLAND_ROOT`, the root image label: the
   * guest agent would find two roots, so the machine fails to boot.
   */
  source: ImageSource;
  /** The absolute guest path to mount the disk at. */
  path: string;
  /**
   * Attaches the disk read-only. Defaults to `false`, so writes to an ext4
   * disk persist in its source. EROFS disks must be read-only.
   */
  readOnly?: boolean;
}

/** A filesystem shared into a machine and mounted at a guest path. */
export interface MountOptions {
  /**
   * The filesystem to share, such as a `NodeFS` from `@lowland/guest/node`
   * for a host directory, or a `BrowserFS` from `@lowland/guest/browser` for
   * the origin private file system.
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
   * The root image, as any source `rootImage()` accepts. Defaults to the
   * canonical image from `@lowland/image`. The root is always read-only
   * beneath a temporary overlay, so the image never changes.
   */
  image?: ImageSource;
  /** Disk images to attach and mount, in order. */
  disks?: readonly DiskOptions[];
  /** Filesystems to share and mount, in order. */
  mounts?: readonly MountOptions[];
  /**
   * A network from `createNetwork()` to attach the machine to. The caller
   * owns the network and closes it.
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

/** The filesystem on a guest block device, read from its superblock. */
async function disk_filesystem(guest: GuestAgent, device: string): Promise<"erofs" | "ext4"> {
  const header = new Uint8Array(2048);
  const file = await guest.fs.open(device);
  let length = 0;
  try {
    while (length < header.byteLength) {
      const read = await file.read(header.subarray(length));
      if (!read) break;
      length += read;
    }
  } finally {
    await file.close();
  }
  const view = new DataView(header.buffer, 0, length);
  if (length >= 1028 && view.getUint32(1024, true) === 0xe0f5e1e2) return "erofs";
  if (length >= 1082 && view.getUint16(1024 + 56, true) === 0xef53) return "ext4";
  throw new Error(`${device} contains neither an EROFS nor an ext4 filesystem`);
}

/**
 * A Linux machine with the canonical kernel, guest agent, and an image.
 *
 * Each value owns one live machine. Close it with `await using`, or with
 * `close()` when its disks need no flushing.
 *
 * @example Run a command
 * ```ts
 * await using linux = await Linux.create();
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
  static async create(options: LinuxOptions = {}): Promise<Linux> {
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

    // The disks configure first, so disk i is device-tree node virtio<i>
    // and can be found in the guest without relying on probe order.
    const disk_plugins = disks.map((disk) => rootImage(disk.source, { writable: !disk.readOnly }));
    const devices: MachinePlugin = {
      async configure(setup) {
        for (const plugin of disk_plugins) await plugin.configure(setup);
        for (const [index, mount] of mounts.entries()) {
          setup.devices.add(fileSystemDevice(mount.source, { tag: `lowland-mount-${index}` }));
        }
      },
    };

    const guest = guestAgent();
    // Attaching allocates the guest's address and NIC, which only a machine
    // that configures the NIC releases. Attach while configuring, so a boot
    // that fails before then leaves the caller's network untouched.
    let network: NetworkAttachment | undefined;
    let network_plugin: MachinePlugin | undefined;
    const attach_network: MachinePlugin = {
      async configure(setup) {
        network = options.network!.attach(guest);
        network_plugin = network[machinePlugin]();
        await network_plugin.configure(setup);
      },
      async booted(machine) {
        await network_plugin?.booted?.(machine);
      },
    };
    const machine = await bootMachine({
      cpus: options.cpus ?? 1,
      plugins: [
        devices,
        rootImage(options.image),
        entropyDevice(),
        guest,
        ...(options.network ? [attach_network] : []),
        ...(options.plugins ?? []),
      ],
    });

    try {
      const devices_by_node = new Map<string, string>();
      for await (const entry of guest.fs.readDir("/sys/block")) {
        const target = await guest.fs.realPath(`/sys/block/${entry.name}`);
        const node = /\/platform\/(virtio\d+)\//.exec(target)?.[1];
        if (node) devices_by_node.set(node, `/dev/${entry.name}`);
      }
      const disk_paths: string[] = [];
      for (const [index, disk] of disks.entries()) {
        const device = devices_by_node.get(`virtio${index}`);
        if (!device) throw new Error(`the guest did not find the disk for ${disk.path}`);
        const type = await disk_filesystem(guest, device);
        await guest.fs.mkdir(disk.path, { recursive: true });
        await guest.mount(device, disk.path, {
          type,
          flags: disk.readOnly ? MountFlags.RDONLY : 0,
          // A read-only ext4 disk must not replay its journal into the file.
          data: disk.readOnly && type === "ext4" ? "noload" : undefined,
        });
        disk_paths.push(disk.path);
      }
      for (const [index, mount] of mounts.entries()) {
        await guest.fs.mkdir(mount.path, { recursive: true });
        await guest.mount(`lowland-mount-${index}`, mount.path, {
          type: "virtiofs",
          flags: mount.readOnly ? MountFlags.RDONLY : 0,
        });
      }
      return new Linux(machine, guest, network, disk_paths);
    } catch (error) {
      await Promise.resolve(machine[Symbol.asyncDispose]()).catch(() => {});
      throw error;
    }
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
   * `/` unless `options.cwd` says otherwise.
   */
  run(argv: readonly string[], options?: ExecOptions): Promise<RunResult> {
    return this.#guest.run(argv, { ...options, cwd: options?.cwd ?? "/" });
  }

  /**
   * Starts a command with streaming standard I/O. It runs in `/` unless
   * `options.cwd` says otherwise.
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
