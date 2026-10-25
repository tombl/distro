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
  readonly plugins: readonly MachinePlugin[];
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
  };

  const plugins: MachinePlugin[] = [];
  try {
    for (const input of inputs) {
      const plugin = machine_plugin(input);
      plugins.push(plugin);
      await plugin.configure(setup);
    }
  } catch (error) {
    await new VirtioBus(devices).close().catch(() => {});
    throw error;
  }

  return {
    args: configured_args,
    devices,
    plugins,
  };
}

export async function run_machine_booted(
  plugins: readonly MachinePlugin[],
  machine: Machine,
): Promise<void> {
  for (const plugin of plugins) await plugin.booted?.(machine);
}
