// SPDX-License-Identifier: MIT

import type { Machine } from "./index.ts";
import {
  machinePlugin,
  type MachinePlugin,
  type MachinePluginInput,
  type MachineSetup,
} from "./plugin.ts";
import { VirtioBus } from "./virtio/bus.ts";
import type { Device } from "./virtio/device.ts";

export interface ConfiguredMachine {
  readonly args: readonly string[];
  readonly devices: readonly Device[];
  /** The plugins' archives, concatenated; empty when none added one. */
  readonly initramfs: Uint8Array;
  readonly plugins: readonly MachinePlugin[];
}

// newc archives may be separated by NUL padding in 4-byte units, which the
// kernel skips between members. Each archive starts on such a boundary.
function concatenate_archives(archives: readonly ArrayBufferView[]): Uint8Array {
  // Plain arithmetic: bitwise operators would wrap past 2 GiB.
  const align = (size: number) => Math.ceil(size / 4) * 4;
  const total = archives.reduce((size, archive) => align(size) + archive.byteLength, 0);
  const initramfs = new Uint8Array(total);
  let offset = 0;
  for (const archive of archives) {
    offset = align(offset);
    initramfs.set(new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength), offset);
    offset += archive.byteLength;
  }
  return initramfs;
}

function machine_plugin(input: MachinePluginInput): MachinePlugin {
  return machinePlugin in input ? input[machinePlugin]() : input;
}

export async function configure_machine(
  args: readonly string[],
  inputs: readonly MachinePluginInput[],
  bootConsole: ReadableStream<Uint8Array> = new ReadableStream(),
): Promise<ConfiguredMachine> {
  const configured_args = [...args];
  const devices: Device[] = [];
  const archives: PromiseLike<ArrayBufferView>[] = [];
  const setup: MachineSetup = {
    bootConsole,
    args: {
      add(...next) {
        configured_args.push(...next);
      },
    },
    devices: {
      add(...next) {
        devices.push(...next);
      },
    },
    initramfs: {
      add(archive) {
        const pending = Promise.resolve(archive);
        // Observed here so an archive that rejects while a later plugin is
        // still configuring is not reported as unhandled.
        pending.catch(() => {});
        archives.push(pending);
      },
    },
  };

  const plugins: MachinePlugin[] = [];
  let initramfs: Uint8Array;
  try {
    for (const input of inputs) {
      const plugin = machine_plugin(input);
      plugins.push(plugin);
      await plugin.configure(setup);
    }
    initramfs = concatenate_archives(await Promise.all(archives));
  } catch (error) {
    await new VirtioBus(devices).close().catch(() => {});
    throw error;
  }

  return {
    args: configured_args,
    devices,
    initramfs,
    plugins,
  };
}

export async function run_machine_booted(
  plugins: readonly MachinePlugin[],
  machine: Machine,
): Promise<void> {
  for (const plugin of plugins) await plugin.booted?.(machine);
}

export async function run_machine_closing(plugins: readonly MachinePlugin[]): Promise<void> {
  let failure: { error: unknown } | undefined;
  for (const plugin of plugins.toReversed()) {
    try {
      await plugin.closing?.();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}
