// SPDX-License-Identifier: MIT

import {
  bootMachine,
  entropyDevice,
  type Machine,
  type MachineExit,
  type Network,
  type NetworkAttachment,
  type PowerOptions,
} from "./machine/index.ts";
import type { MachinePluginInput } from "./machine/plugin.ts";
import {
  guestAgent,
  type ChildProcess,
  type FileSystem,
  type GuestAgent,
  type Mount,
  type MountSource,
  type RunOptions,
  type RunResult,
  type SpawnOptions,
} from "./guest/index.ts";

/** The configuration of a machine created by `Linux.create()`. */
export interface LinuxOptions {
  /**
   * The root: `rootImage()` from `lowland/image` for the canonical image, a
   * mount entry at `/`, or a source of your own, which is mounted beneath a
   * temporary overlay, so it never changes.
   *
   * There is no default, so an application that boots its own image never
   * bundles the canonical one: only importing `lowland/image` does.
   */
  image: Mount | MountSource;
  /** Further mount table entries, such as disks, shares and tmpfs. */
  mounts?: readonly Mount[];
  /**
   * A network from `createNetwork()` in `lowland/machine` to attach the
   * machine to. The caller owns the network and closes it.
   */
  network?: Network;
  /** Virtual CPUs to boot. Defaults to 1. */
  cpus?: number;
  /** A program to start in the root once it has booted; its exit powers the machine off. */
  init?: readonly string[];
  /** Further plugins, configured after the machine's own devices. */
  plugins?: readonly MachinePluginInput[];
}

/**
 * A machine with the canonical kernel and the guest agent, booted into an
 * image: `bootMachine()` and `guestAgent()` from `lowland/machine` and
 * `lowland/guest`, composed.
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
  /** The machine, for its lifecycle and its devices. */
  readonly machine: Machine;
  /** The guest agent, for mounts, disks and the rest of its API. */
  readonly guest: GuestAgent;
  /** The machine's attachment to `options.network`, or `undefined` without one. */
  readonly network: NetworkAttachment | undefined;

  private constructor(machine: Machine, guest: GuestAgent, network: NetworkAttachment | undefined) {
    this.machine = machine;
    this.guest = guest;
    this.network = network;
  }

  /** Boots a machine and its mount table. */
  static async create(options: LinuxOptions): Promise<Linux> {
    const image = options?.image;
    if (image === undefined) {
      throw new TypeError("Linux.create() needs an image, such as rootImage() from lowland/image");
    }
    // A mount entry has a path; no source does.
    const root: Mount =
      typeof (image as Partial<Mount>).path === "string"
        ? (image as Mount)
        : { path: "/", source: image as MountSource, mode: "overlay" };
    if (root.path !== "/") throw new TypeError(`the image must be mounted at /, not ${root.path}`);
    const guest = guestAgent({ mounts: [root, ...(options.mounts ?? [])], init: options.init });
    const network = options.network?.attach();
    const machine = await bootMachine({
      cpus: options.cpus ?? 1,
      plugins: [guest, entropyDevice(), ...(network ? [network] : []), ...(options.plugins ?? [])],
    });
    return new Linux(machine, guest, network);
  }

  /** File operations in the guest. */
  get fs(): FileSystem {
    return this.guest.fs;
  }

  /** Settles once the machine has ended, and never rejects. */
  get exited(): Promise<MachineExit> {
    return this.machine.exited;
  }

  /** `guest.spawn()`: starts a command with streaming standard I/O, or on a terminal. */
  spawn(argv: readonly string[], options?: SpawnOptions): Promise<ChildProcess> {
    return this.guest.spawn(argv, options);
  }

  /** `guest.run()`: runs a command and collects its status, stdout and stderr. */
  run(argv: readonly string[], options?: RunOptions): Promise<RunResult> {
    return this.guest.run(argv, options);
  }

  /** `machine.shutdown()`: powers off, and kills after `timeoutMs` (30 000 ms). */
  shutdown(options?: PowerOptions): Promise<MachineExit> {
    return this.machine.shutdown(options);
  }

  /** `machine.reboot()`: resolves once the guest has booted again. */
  reboot(options?: PowerOptions): Promise<void> {
    return this.machine.reboot(options);
  }

  /** `machine.kill()`: stops at once. Writes the guest has not flushed are lost. */
  kill(): void {
    this.machine.kill();
  }

  /** `shutdown()`, with its default timeout. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.machine[Symbol.asyncDispose]();
  }
}
