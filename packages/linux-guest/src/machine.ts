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
import { attach_guest, type GuestNetwork, type Network } from "./network.ts";

export interface SpawnGuestOptions extends Omit<
  SpawnMachineOptions,
  "devices" | "initcpio" | "cmdline"
> {
  /** Extra virtio devices to boot with — a console or entropy device from `@tombl/linux`, say. */
  devices?: readonly VirtioDevice[];
  /** Guests attached to the same network can connect to each other. */
  network?: Network;
  /** Extra kernel command line arguments, appended to the defaults. */
  cmdline?: string;
  /** Boot from these assets instead of the ones bundled with the package. */
  assets?: GuestAssets;
}

/**
 * A booted Linux guest: the machine itself plus the guest agent's
 * capabilities — `exec` for processes, `fs` for files, and `network` when
 * spawned with one.
 */
export interface Guest {
  /** The underlying `@tombl/linux` machine. `machine.close()` shuts the guest down. */
  readonly machine: Machine;
  /** File operations in the guest. */
  readonly fs: FileSystem;
  /** Runs programs in the guest. */
  readonly exec: Exec;
  /** The guest's network attachment; `undefined` unless spawned with `network`. */
  readonly network: GuestNetwork | undefined;
}

/** A guest spawned with a `network`; `network` is always present. */
export interface NetworkedGuest extends Guest {
  readonly network: GuestNetwork;
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

async function run_network_command(exec: Exec, command: string[]) {
  const child = await exec(command);
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (!status.success) {
    const output = `${stdout}${stderr}`.trim();
    throw new Error(
      `guest network command failed (${status.code}): ${command.join(" ")}${output ? `: ${output}` : ""}`,
    );
  }
}

async function configure_network(exec: Exec, fs: FileSystem, address: string, gateway: string) {
  const deadline = performance.now() + 10_000;
  let failure: unknown;
  while (performance.now() < deadline) {
    try {
      await fs.stat("/sys/class/net/eth0");
      failure = undefined;
      break;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (failure) throw new Error("guest network device did not appear", { cause: failure });

  // Bring loopback up: the kernel creates lo but leaves it down, so anything
  // binding or connecting to 127.0.0.1 (a local server, ssh to localhost)
  // fails until it is up. It has no dependency on eth0 appearing.
  await run_network_command(exec, ["/sbin/ifconfig", "lo", "up"]);

  await run_network_command(exec, [
    "/sbin/ifconfig",
    "eth0",
    address,
    "netmask",
    "255.255.255.0",
    "up",
  ]);
  await run_network_command(exec, ["/sbin/route", "add", "default", "gw", gateway, "eth0"]);
}

/**
 * Boots a Linux guest — the packaged kernel and root filesystem, with the
 * guest agent as init — and resolves once the agent can serve requests:
 * `exec`, `fs`, and (given `network`) networking are all usable from then
 * on.
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
 *
 * @example Put two guests on one network
 * ```ts
 * const network = createNetwork({ connectTcp, resolveDns });
 * const a = await spawnGuest({ network });
 * const b = await spawnGuest({ network });
 * const ping = await b.exec(["ping", "-c", "1", a.network.address]);
 * console.log(await new Response(ping.stdout).text());
 * ```
 */
export function spawnGuest(
  options: SpawnGuestOptions & { network: Network },
): Promise<NetworkedGuest>;
export function spawnGuest(options?: SpawnGuestOptions): Promise<Guest>;
export async function spawnGuest(options: SpawnGuestOptions = {}): Promise<Guest> {
  const { devices = [], network, cmdline = "", assets, ...machine_options } = options;
  const { initramfs, rootfs } = assets ?? (await packaged_assets());
  const attached = network ? attach_guest(network) : undefined;
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
      devices: [root, vsock, ...(attached ? [attached.attachment.device] : []), ...devices],
      initcpio: initramfs,
    });
  } catch (error) {
    attached?.attachment.close();
    throw error;
  }
  void machine.closed
    .finally(() => {
      attached?.attachment.close();
    })
    .catch(() => {});

  try {
    await wait_for_guest(client, machine);
    if (attached) {
      await configure_network(
        client.exec,
        client.fs,
        attached.attachment.address,
        network!.gateway,
      );
    }
    return { machine, fs: client.fs, exec: client.exec, network: attached?.guest_network };
  } catch (error) {
    machine.close();
    throw error;
  }
}
