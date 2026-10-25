// SPDX-License-Identifier: MIT

import type { DeviceTreeNode } from "./devicetree.ts";
import type { Machine } from "./index.ts";
import type { VirtioDevice } from "./virtio/core.ts";

/** Returns the machine plugin represented by a higher-level object. */
export const getMachinePlugin: unique symbol = Symbol("getMachinePlugin");

/** An object that can contribute to a machine without exposing its plugin hooks directly. */
export interface MachinePluginProvider {
  [getMachinePlugin](): MachinePlugin;
}

/** A machine plugin or an object that provides one. */
export type MachinePluginInput = MachinePlugin | MachinePluginProvider;

/** Kernel command-line arguments accumulated while configuring a machine. */
export interface KernelArguments {
  /** Appends arguments in the order the kernel should receive them. */
  add(...args: string[]): void;
}

/** Virtio devices accumulated while configuring a machine. */
export interface MachineDevices {
  /** Attaches devices in device-tree order. */
  add(...devices: VirtioDevice[]): void;
}

/** Device-tree changes accumulated while configuring a machine. */
export interface DeviceTreeBuilder {
  /** Recursively merges a fragment over the generated machine device tree. */
  merge(fragment: DeviceTreeNode): void;
}

/** The configure-only surface made available to machine plugins. */
export interface MachineSetup {
  readonly args: KernelArguments;
  readonly devices: MachineDevices;
  readonly deviceTree: DeviceTreeBuilder;
}

/** A composable contribution to a machine. */
export interface MachinePlugin {
  /** Contributes configuration before the machine is booted. */
  configure(setup: MachineSetup): void | Promise<void>;
  /** Runs after boot; `bootMachine()` does not resolve until this hook does. */
  booted?(machine: Machine): void | Promise<void>;
  /**
   * Runs when `machine.close()` is called, before workers and devices are torn
   * down. Hooks run one at a time in reverse plugin order, so a plugin can
   * still use the plugins listed before it. Every hook runs even if one
   * rejects; the first rejection makes `machine.closed` reject and forces
   * teardown (see {@link Machine.close}). There is no general timeout, so a
   * hook must bound its own work. Hooks do not run when the guest powers off
   * or the machine fails.
   */
  closing?(): void | Promise<void>;
}
