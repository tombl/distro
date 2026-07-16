import {
  BlockDevice,
  type Machine,
  spawnMachine,
  type SpawnMachineOptions,
  type VirtioDevice,
  VsockDevice,
} from "@tombl/linux";
import { initramfs, rootfs, rootfsSize } from "./assets.ts";
import {
  createGuestClient,
  type Exec,
  type FileSystem,
  type GuestClientCapabilities,
} from "./client.ts";

export interface SpawnGuestOptions
  extends Omit<SpawnMachineOptions, "devices" | "initcpio"> {
  devices?: readonly VirtioDevice[];
}

export interface Guest {
  readonly machine: Machine;
  readonly fs: FileSystem;
  readonly exec: Exec;
}

async function waitForGuest(
  client: GuestClientCapabilities,
  machine: Machine,
  signal?: AbortSignal,
) {
  let machine_ended = false;
  const ended = machine.closed.then(
    () => {
      machine_ended = true;
      throw signal?.reason ??
        new Error("machine closed before guest became ready");
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
      signal?.throwIfAborted();
      if (machine_ended) throw error;
      failure = error;
    }
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 25)),
      ended,
    ]);
  } while (performance.now() < deadline);
  throw new Error("guest agent did not become ready", { cause: failure });
}

export async function spawnGuest(
  options: SpawnGuestOptions = {},
): Promise<Guest> {
  if (!Number.isSafeInteger(rootfsSize) || rootfsSize <= 0) {
    throw new Error("invalid packaged guest rootfs size");
  }

  const { devices = [], ...machine_options } = options;
  const vsock = new VsockDevice();
  const root = new BlockDevice({
    capacity: rootfsSize,
    async read(offset, length) {
      return (await rootfs).subarray(offset, offset + length);
    },
  });
  const client = createGuestClient(vsock);
  const machine = await spawnMachine({
    ...machine_options,
    devices: [root, vsock, ...devices],
    initcpio: initramfs,
  });

  try {
    await waitForGuest(client, machine, options.signal);
    return { machine, fs: client.fs, exec: client.exec };
  } catch (error) {
    machine.close();
    throw error;
  }
}
