import {
  blockDevice,
  bootMachine,
  type BootMachineOptions,
  vsockDevice,
  type Machine,
  type VirtioDevice,
} from "@lowland/kernel";
import {
  create_guest_client,
  type Exec,
  type FileSystem,
  type GuestClientCapabilities,
  type Mount,
  type Unmount,
} from "./client.ts";
import { attach_guest, type GuestNetwork, type Network } from "./network.ts";

export interface SpawnGuestOptions extends Omit<
  BootMachineOptions,
  "plugins" | "initcpio" | "args"
> {
  /** EROFS or ext4 system image labeled LOWLAND_ROOT. Device order is not significant. */
  root: VirtioDevice;
  /** Extra virtio devices to boot with — a console or entropy device from `@lowland/kernel`, say. */
  devices?: readonly VirtioDevice[];
  /** Guests attached to the same network can connect to each other. */
  network?: Network;
  /** Extra kernel command line arguments, appended to the defaults. */
  cmdline?: string;
  /** Receives kernel output emitted before the guest's regular console is ready. */
  bootConsole?: WritableStream<Uint8Array>;
}

interface NodeProcess {
  getBuiltinModule?: (id: "node:fs/promises") => {
    readFile(path: URL): Promise<Uint8Array<ArrayBuffer>>;
  };
}

const agent_image = (async () => {
  const url = new URL("../agent.erofs", import.meta.url);
  const process = (globalThis as { process?: NodeProcess }).process;
  if (process?.getBuiltinModule) {
    return process.getBuiltinModule("node:fs/promises").readFile(url);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to load guest agent image: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
})();

async function agent_device() {
  const bytes = await agent_image;
  return blockDevice({
    capacity: bytes.byteLength,
    read(offset, target) {
      const source = bytes.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  });
}

/**
 * A booted Linux guest: the machine itself plus the guest agent's
 * capabilities — `exec` for processes, `fs` for files, and `network` when
 * spawned with one.
 */
export interface Guest {
  /** The underlying `@lowland/kernel` machine. `machine.close()` shuts the guest down. */
  readonly machine: Machine;
  /** File operations in the guest. */
  readonly fs: FileSystem;
  /** Runs programs in the guest. */
  readonly exec: Exec;
  /** Mounts a filesystem in the guest without spawning a helper process. */
  readonly mount: Mount;
  /** Unmounts a filesystem in the guest without spawning a helper process. */
  readonly unmount: Unmount;
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

  // Each agent exec requires a WebAssembly process-memory handoff. Run the
  // related setup as one single-threaded guest job so a routine boot does not
  // repeatedly snapshot the multithreaded agent merely to configure one NIC.
  // Loopback must be included because Linux creates it down by default.
  await run_network_command(exec, [
    "/bin/sh",
    "-c",
    [
      "/sbin/ifconfig lo up",
      `/sbin/ifconfig eth0 ${address} netmask 255.255.255.0 up`,
      `/sbin/route add default gw ${gateway} eth0`,
    ].join(" && "),
  ]);
}

/**
 * Boots a Linux guest from the caller's root block device and resolves once
 * the guest agent can serve requests:
 * `exec`, `fs`, and (given `network`) networking are all usable from then
 * on.
 *
 * `guest.machine.close()` shuts the guest down when nothing inside it
 * should stay running.
 *
 * @example Boot a guest and run a command
 * ```ts
 * const guest = await spawnGuest({ cpus: 1, root: blockDevice(storage) });
 * const process = await guest.exec(["uname", "-a"]);
 * console.log(await new Response(process.stdout).text());
 * guest.machine.close();
 * ```
 *
 * @example Put two guests on one network
 * ```ts
 * const network = createNetwork({ connectTcp, resolveDns });
 * const a = await spawnGuest({ cpus: 1, root: blockDevice(aStorage), network });
 * const b = await spawnGuest({ cpus: 1, root: blockDevice(bStorage), network });
 * const ping = await b.exec(["ping", "-c", "1", a.network.address]);
 * console.log(await new Response(ping.stdout).text());
 * ```
 */
export function spawnGuest(
  options: SpawnGuestOptions & { network: Network },
): Promise<NetworkedGuest>;
export function spawnGuest(options: SpawnGuestOptions): Promise<Guest>;
export async function spawnGuest(options: SpawnGuestOptions): Promise<Guest> {
  const { devices = [], root, network, cmdline = "", bootConsole, ...machine_options } = options;
  const attached = network ? attach_guest(network) : undefined;
  const vsock = vsockDevice();
  const client = create_guest_client(vsock);
  const agent = await agent_device();
  let machine: Machine;
  try {
    machine = await bootMachine({
      ...machine_options,
      args: ["root=/dev/vda", "rootfstype=erofs", "ro", "rootwait", "init=/init", cmdline].filter(
        Boolean,
      ),
      plugins: [agent, ...devices, root, vsock, ...(attached ? [attached.attachment.device] : [])],
    });
    if (bootConsole) {
      void machine.bootConsole.pipeTo(bootConsole).catch(() => {});
    }
  } catch (error) {
    attached?.attachment.close();
    throw error;
  }
  // Network ownership follows the NIC itself. This also covers plugin
  // configuration/boot failures without adding an Ethernet-specific hook.
  void attached?.attachment.device.closed
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
    return {
      machine,
      fs: client.fs,
      exec: client.exec,
      mount: client.mount,
      unmount: client.unmount,
      network: attached?.guest_network,
    };
  } catch (error) {
    machine.close();
    throw error;
  }
}
