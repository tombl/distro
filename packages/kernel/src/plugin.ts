// SPDX-License-Identifier: MIT

import type { Machine } from "./index.ts";
import type { Device } from "./virtio/device.ts";

/** Returns the machine plugin represented by a higher-level object. */
export const machinePlugin: unique symbol = Symbol("machinePlugin");

/** An object that can contribute to a machine without exposing its plugin hooks directly. */
export interface MachinePluginProvider {
  [machinePlugin](): MachinePlugin;
}

/** A machine plugin or an object that provides one. */
export type MachinePluginInput = MachinePlugin | MachinePluginProvider;

/** Kernel command-line arguments accumulated while configuring a machine. */
export interface KernelArguments {
  /** Appends arguments in the order the kernel should receive them. */
  add(...args: string[]): void;
}

/** Devices accumulated while configuring a machine. */
export interface MachineDevices {
  /** Attaches devices in device-tree order. */
  add(...devices: Device[]): void;
}

/** Configuration available to machine plugins before boot. */
export interface MachineSetup {
  readonly args: KernelArguments;
  readonly devices: MachineDevices;
  /**
   * Early kernel output. Consume this stream during configuration, before the
   * machine boots.
   */
  readonly bootConsole: ReadableStream<Uint8Array>;
}

/** A composable contribution to a machine. */
export interface MachinePlugin {
  /** Contributes configuration before the machine is booted. */
  configure(setup: MachineSetup): void | Promise<void>;
  /** Runs after boot; `bootMachine()` does not resolve until this hook does. */
  booted?(machine: Machine): void | Promise<void>;
}

/** Routes early kernel output to a writable stream before the machine boots. */
export function bootConsole(output: WritableStream<Uint8Array>): MachinePlugin {
  return {
    configure(setup) {
      void setup.bootConsole.pipeTo(output, { preventClose: true }).catch(() => {});
    },
  };
}
