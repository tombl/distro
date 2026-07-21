import {
  blockDevice,
  vsockDevice,
  type Machine,
  spawnMachine,
  type SpawnMachineOptions,
  type VirtioDevice,
} from "@tombl/linux";
import { type GuestAssets, packaged_assets } from "./assets.ts";
import {
  create_guest_client,
  type Exec,
  type FileSystem,
  type GuestClientCapabilities,
} from "./client.ts";

export interface SpawnGuestOptions extends Omit<
  SpawnMachineOptions,
  "devices" | "initcpio" | "cmdline"
> {
  /** Extra virtio devices to boot with — a console or entropy device from `@tombl/linux`, say. */
  devices?: readonly VirtioDevice[];
  /** Extra kernel command line arguments, appended to the defaults. */
  cmdline?: string;
  /** Boot from these assets instead of the ones bundled with the package. */
  assets?: GuestAssets;
}

/**
 * A booted Linux guest: the machine itself plus the guest agent's
 * capabilities — `exec` for processes and `fs` for files.
 */
export interface Guest {
  /** The underlying `@tombl/linux` machine. `machine.close()` shuts the guest down. */
  readonly machine: Machine;
  /** File operations in the guest. */
  readonly fs: FileSystem;
  /** Runs programs in the guest. */
  readonly exec: Exec;
}

async function wait_for_guest(client: GuestClientCapabilities, machine: Machine) {
  let machine_ended = false;
  const ended = machine.closed.then(
    () => {
      machine_ended = true;
      throw new Error("machine closed before guest became ready");
    },
    (error) => {
      machine_ended = true;
      throw error;
    },
  );

  const deadline = performance.now() + 30_000;
  let failure: unknown;
  do {
    try {
      await Promise.race([client.ping(1000), ended]);
      return;
    } catch (error) {
      if (machine_ended) throw error;
      failure = error;
    }
    await Promise.race([new Promise((resolve) => setTimeout(resolve, 25)), ended]);
  } while (performance.now() < deadline);
  throw new Error("guest agent did not become ready", { cause: failure });
}

/**
 * Boots a Linux guest — the packaged kernel and root filesystem, with the
 * guest agent as init — and resolves once the agent can serve requests:
 * `exec` and `fs` are usable from then on.
 *
 * `guest.machine.close()` shuts the guest down when nothing inside it
 * should stay running.
 *
 * @example Boot a guest and run a command
 * ```ts
 * const guest = await spawnGuest();
 * const process = await guest.exec(["uname", "-a"]);
 * console.log(await new Response(process.stdout).text());
 * guest.machine.close();
 * ```
 */
export function spawnGuest(options?: SpawnGuestOptions): Promise<Guest>;
export async function spawnGuest(options: SpawnGuestOptions = {}): Promise<Guest> {
  const { devices = [], cmdline = "", assets, ...machine_options } = options;
  const { initramfs, rootfs } = assets ?? (await packaged_assets());
  const vsock = vsockDevice();
  const root = blockDevice({
    capacity: rootfs.byteLength,
    read(offset, length) {
      return rootfs.subarray(offset, offset + length);
    },
  });
  const client = create_guest_client(vsock);
  let machine: Machine;
  try {
    machine = await spawnMachine({
      ...machine_options,
      cmdline,
      devices: [root, vsock, ...devices],
      initcpio: initramfs,
    });
  } catch (error) {
    throw error;
  }

  try {
    await wait_for_guest(client, machine);
    return { machine, fs: client.fs, exec: client.exec };
  } catch (error) {
    machine.close();
    throw error;
  }
}
