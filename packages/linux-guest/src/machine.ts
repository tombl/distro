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
  devices?: readonly VirtioDevice[];
  /** Guests attached to the same network can connect to each other. */
  network?: Network;
  cmdline?: string;
  /** Boot from these assets instead of the ones bundled with the package. */
  assets?: GuestAssets;
}

export interface Guest {
  readonly machine: Machine;
  readonly fs: FileSystem;
  readonly exec: Exec;
  readonly network: GuestNetwork | undefined;
}

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
  void machine.closed.finally(() => {
    attached?.attachment.close();
  });

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
