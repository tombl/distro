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

/**
 * The initial ramdisk accumulated while configuring a machine. The kernel
 * unpacks it into its root filesystem and runs `/init` from it.
 */
export interface MachineInitramfs {
  /**
   * Appends an uncompressed newc (`cpio -H newc`) archive. Archives are
   * unpacked in the order they were added, so a later archive's files replace
   * an earlier archive's files at the same path, as when concatenating
   * initramfs images for any Linux bootloader. A promise is awaited before
   * the machine boots, and its rejection fails `bootMachine()`.
   */
  add(archive: ArrayBufferView | PromiseLike<ArrayBufferView>): void;
}

/** Configuration available to machine plugins before boot. */
export interface MachineSetup {
  readonly args: KernelArguments;
  readonly devices: MachineDevices;
  readonly initramfs: MachineInitramfs;
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
  /**
   * Runs after every boot, reboots included. `bootMachine()` does not
   * resolve until this hook does, nor `machine.reboot()`.
   */
  booted?(machine: Machine): void | Promise<void>;
  /**
   * Asked by `machine.shutdown()` and `machine.reboot()`, in reverse plugin
   * order, to start an orderly power-off or reboot, such as by signalling
   * the guest's init. Resolve `true` once this plugin has started it: no
   * later plugin is asked, and the machine waits for the guest. Resolve
   * `false`, or reject, if it has started nothing, and the next plugin is
   * asked, then the kernel's power button.
   */
  power?(action: "poweroff" | "reboot"): boolean | Promise<boolean>;
}

/** Routes early kernel output to a writable stream before the machine boots. */
export function bootConsole(output: WritableStream<Uint8Array>): MachinePlugin {
  return {
    configure(setup) {
      void setup.bootConsole.pipeTo(output, { preventClose: true }).catch(() => {});
    },
  };
}
