// SPDX-License-Identifier: MIT

import { type DeviceTreeNode, generate_devicetree } from "./devicetree.ts";
import { platform, type WorkerHandle } from "./platform.ts";
import { configure_machine, run_machine_booted } from "./plugin-internal.ts";
import type { MachinePluginInput } from "./plugin.ts";
import { assert, unreachable } from "./util.ts";
import { read_wasm_memories, type WasmMemoryType } from "./wasm_binary.ts";
import { VirtioBus } from "./virtio/bus.ts";
import {
  allocate_shared_memory,
  type Imports,
  type Instance,
  kernel_imports,
  MachineTerminationReason,
  PowerButton,
  type UserContext,
  UserMemory,
} from "./wasm.ts";
import type { ForwardedInitMessage, InitMessage, WorkerMessage } from "./worker.ts";

export {
  bootConsole,
  type KernelArguments,
  type MachineDevices,
  type MachineInitramfs,
  machinePlugin,
  type MachinePlugin,
  type MachinePluginInput,
  type MachinePluginProvider,
  type MachineSetup,
} from "./plugin.ts";
export type { Device } from "./virtio/device.ts";
export { type ErrnoCode, SystemError } from "./error.ts";
export { blockDevice, type BlockDeviceOptions, type BlockStorage } from "./virtio/block.ts";
export {
  type DiskFileHandle,
  type DiskSource,
  diskStorage,
  type DiskStorageOptions,
} from "./disk.ts";
export { type Endpoint, serveDevice, serveDeviceError, workerDevice } from "./virtio/remote.ts";
export { type ConsoleDevice, consoleDevice } from "./virtio/console.ts";
export { entropyDevice } from "./virtio/entropy.ts";
export {
  type FS,
  type FSAttributes,
  type FSCreateContext,
  type FSDirectoryEntry,
  type FSDeviceOptions,
  type FSSetAttributes,
  type FSStat,
  type FSTimestamp,
  fileSystemDevice,
} from "./virtio/fs.ts";
export {
  type EthernetDevice,
  ethernetDevice,
  type EthernetDeviceOptions,
  type EthernetNetwork,
  ethernetNetwork,
  type EthernetPort,
  type MacAddress,
} from "./virtio/net.ts";
export {
  type VsockConnection,
  type VsockDevice,
  vsockDevice,
  type VsockListener,
} from "./virtio/vsock.ts";
export {
  createNetwork,
  type Network,
  type NetworkAddress,
  type NetworkAttachment,
  type NetworkOptions,
  type TcpConnection,
  type TcpConnectOptions,
  type TcpSession,
  type UdpConnection,
  type UdpConnectOptions,
} from "./network/network.ts";
export { guestFetchHandler } from "./network/guest-fetch-handler.ts";
export { hostFetchNetwork } from "./network/host-fetch-network.ts";

/** The resources and boot configuration of a Linux machine. */
export interface BootMachineOptions {
  /** Virtual CPUs to boot, one Web Worker each. */
  cpus: number;
  /** Kernel command-line arguments, appended after `console=hvc0`. */
  args?: readonly string[];
  /**
   * Plugins to configure in array order before the machine boots. They add
   * the devices, kernel arguments, and initramfs archives.
   */
  plugins?: readonly MachinePluginInput[];
  /**
   * What a reboot does. `"restart"`, the default, boots a fresh kernel on the
   * same devices, as QEMU does: the devices are reset rather than configured
   * again, and every plugin's `booted` hook runs again. `"exit"` ends the
   * machine with the exit reason `"reboot"`, like QEMU's `-no-reboot`.
   */
  reboot?: "restart" | "exit";
}

/**
 * How a machine ended. `"poweroff"` covers a halt too. `"reboot"` happens
 * only with `reboot: "exit"`. `"crash"` is a kernel panic, as a
 * {@link MachinePanicError}, or a failure on the host, such as a device's.
 */
export type MachineExit =
  | { readonly reason: "poweroff" | "kill" }
  | { readonly reason: "reboot" }
  | { readonly reason: "crash"; readonly error: unknown };

/** Options for {@link Machine.shutdown} and {@link Machine.reboot}. */
export interface PowerOptions {
  /**
   * How long the guest has to finish, after which the machine is killed.
   * Defaults to 30 000 ms.
   */
  timeoutMs?: number;
}

/**
 * A booted Linux machine: one shared WebAssembly memory, one Web Worker per
 * virtual CPU, and its virtio devices.
 *
 * @example Power a machine off when a scope ends
 * ```ts
 * await using machine = await bootMachine({ cpus: 1, plugins });
 * ```
 */
export interface Machine extends AsyncDisposable {
  /** The machine's physical memory. A reboot replaces it. */
  readonly memory: WebAssembly.Memory;
  /**
   * Settles once the machine has ended, however it ended: the guest powered
   * off, it was killed, or it crashed. It never rejects.
   */
  readonly exited: Promise<MachineExit>;
  /**
   * Presses the power button and resolves once the machine has ended. Each
   * plugin's `power` hook is asked, in reverse plugin order, to start the
   * power-off, such as the guest agent, which signals its PID 1. If none
   * does, the kernel's own power button runs the image's `/sbin/poweroff`.
   * A guest that has not ended after `timeoutMs` is killed.
   */
  shutdown(options?: PowerOptions): Promise<MachineExit>;
  /**
   * Reboots the guest the way {@link shutdown} powers it off, and resolves
   * once it has booted again and every `booted` hook has run. Rejects if
   * the machine ends instead, as it does with `reboot: "exit"`. A guest
   * that has not booted again after `timeoutMs` is killed.
   */
  reboot(options?: PowerOptions): Promise<void>;
  /**
   * Pulls the plug: stops the machine at once. Writes that the guest has not
   * flushed are lost.
   */
  kill(): void;
  /** `shutdown()` with a 30 s timeout. */
  [Symbol.asyncDispose](): Promise<void>;
}

export class MachinePanicError extends Error {
  constructor() {
    super("kernel panic");
    this.name = "MachinePanicError";
  }
}

async function read_resources() {
  const { bytes, module: vmlinux } = await platform.load_wasm(
    new URL("../../assets/vmlinux.wasm", import.meta.url),
  );

  const memories = read_wasm_memories(bytes);
  assert(
    memories.imports.length === 1 && memories.definitions.length === 0,
    "Kernel must define exactly one imported memory",
  );
  const memory = memories.imports[0]!;
  assert(
    memory.module === "env" && memory.name === "memory",
    "Kernel memory must be imported as env.memory",
  );
  assert(
    memory.type.address === "i32" && memory.type.shared,
    "Kernel memory must be a shared memory32",
  );

  const custom_section = (name: string) => {
    const sections = WebAssembly.Module.customSections(vmlinux, name);
    const section = sections[0];
    assert(section && sections.length === 1, `Missing custom section: ${name}`);
    return section;
  };

  const sections = JSON.parse(new TextDecoder().decode(custom_section(".linux.sections")));
  const initramfs = new Uint8Array(custom_section(".linux.initramfs"));

  return {
    vmlinux,
    memory: memory.type,
    sections,
    initramfs,
  };
}

let resources: ReturnType<typeof read_resources> | undefined;
const load_resources = () => (resources ??= read_resources());

const PAGE_SIZE = 0x10000;
const EAGAIN = 11;
const EBUSY = 16;
// Leave the final wasm32 page out so the physical-memory size fits in u32.
const KERNEL_MEMORY_MAXIMUM_PAGES = 0xffff;

function kernel_initial_pages(memory: WasmMemoryType): number {
  const maximum = BigInt(KERNEL_MEMORY_MAXIMUM_PAGES);
  assert(
    memory.minimum <= maximum && memory.maximum !== undefined && memory.maximum >= maximum,
    "Kernel memory limits are incompatible with a 4 GiB - 64 KiB memory",
  );
  return Number(memory.minimum);
}

/**
 * The kernel pulls each boot blob with the device tree's convention: called
 * with (0, 0) it asks for the size, then it copies into a buffer it allocated.
 */
function boot_blob(memory: WebAssembly.Memory, blob: Uint8Array, name: string) {
  return (buf: number, size: number) => {
    const address = buf >>> 0;
    const capacity = size >>> 0;
    if (address === 0 && capacity === 0) return blob.byteLength;
    assert(capacity >= blob.byteLength, `${name} truncated`);
    new Uint8Array(memory.buffer).set(blob, address);
    return blob.byteLength;
  };
}

/**
 * Boots the packaged kernel and resolves once it is running: the devices
 * are live and the kernel is executing from then on. What runs next is up
 * to the plugins' initramfs archives and the kernel command line.
 *
 * In a browser the page must be cross-origin isolated, because the
 * machine's memory is shared between workers.
 *
 * @example
 * ```ts
 * const machine = await bootMachine({
 *   cpus: navigator.hardwareConcurrency,
 *   plugins: [
 *     { configure: (setup) => setup.initramfs.add(initramfs) },
 *     consoleDevice(input, output),
 *     entropyDevice(),
 *     blockDevice(disk),
 *   ],
 * });
 * ```
 */
export async function bootMachine(options: BootMachineOptions): Promise<Machine> {
  if (options.reboot !== undefined && options.reboot !== "restart" && options.reboot !== "exit") {
    throw new TypeError(`reboot must be "restart" or "exit", not ${String(options.reboot)}`);
  }
  let boot_console_controller!: ReadableStreamDefaultController<Uint8Array>;
  let boot_console_closed = false;
  const boot_console = new ReadableStream<Uint8Array>({
    start(controller) {
      boot_console_controller = controller;
    },
    cancel() {
      boot_console_closed = true;
    },
  });
  // Closing is skipped once a reader cancelled the stream, which would throw.
  const boot_console_close = () => {
    if (boot_console_closed) return;
    boot_console_closed = true;
    boot_console_controller.close();
  };
  let configured;
  try {
    configured = await configure_machine(options.args ?? [], options.plugins ?? [], boot_console);
  } catch (error) {
    // Close the stream so a bootConsole() pipe ends and releases its output.
    boot_console_close();
    throw error;
  }
  const { plugins } = configured;
  const bus = new VirtioBus(configured.devices);
  // Each boot is a generation. A restarted machine ignores whatever the
  // previous kernel's workers still post.
  let generation = 0;
  let workers = new Set<WorkerHandle>();
  let instance: Instance | undefined;
  let wasm_memory!: WebAssembly.Memory;
  let machine!: Machine;

  let exit: MachineExit | undefined;
  const exited = Promise.withResolvers<MachineExit>();
  // Settles when the machine is between boots no longer: the next boot's
  // hooks have run, or the machine has ended.
  let restarting: Promise<void> | undefined;
  // Set when the new kernel reboots while its booted hooks still run.
  let reboot_again = false;
  let next_boot = Promise.withResolvers<void>();

  const boot_console_write = (message: ArrayBuffer) => {
    // Boot output is diagnostic and synchronous from the kernel's point of
    // view. Discard it unless a plugin attached a reader before boot.
    if (!boot_console_closed && boot_console.locked) {
      boot_console_controller.enqueue(new Uint8Array(message));
    }
  };

  const terminate_workers = async () => {
    const current = workers;
    workers = new Set();
    await Promise.all(Array.from(current, (worker) => worker.terminate()));
  };

  // Ends the machine once. A power-off waits for the devices to close, which
  // flushes their storage. A kill or a crash does not wait for them, because
  // a request stuck in host storage would keep the machine from ending.
  const kill_requested = Promise.withResolvers<void>();
  // What the machine will report, until it has ended.
  let result: MachineExit | undefined;
  const end = (outcome: MachineExit) => {
    if (exit) {
      if (outcome.reason === "kill") kill_requested.resolve();
      // A device that fails while an orderly end waits for it makes a crash.
      else if (outcome.reason === "crash" && result && result.reason !== "crash") result = outcome;
      return;
    }
    exit = result = outcome;
    generation++;
    const orderly = outcome.reason === "poweroff" || outcome.reason === "reboot";
    if (!orderly) kill_requested.resolve();
    void (async () => {
      try {
        await terminate_workers();
      } catch (error) {
        if (orderly) result = { reason: "crash", error };
      }
      const devices = bus.close();
      const closed = await Promise.race([
        devices.then(
          () => undefined,
          (error: unknown) => ({ error }),
        ),
        kill_requested.promise.then(() => "killed" as const),
      ]);
      if (closed === "killed") {
        void devices.catch(() => {});
        if (result!.reason !== "crash") result = { reason: "kill" };
      } else if (closed && result!.reason !== "crash") {
        result = { reason: "crash", error: closed.error };
      }
      const ended = result!;
      result = undefined;
      boot_console_close();
      next_boot.reject(new Error(`the machine ended instead of rebooting: ${ended.reason}`));
      exited.resolve(ended);
    })();
  };
  void next_boot.promise.catch(() => {});
  const fail = (error: unknown) => end({ reason: "crash", error });
  const kill = () => end({ reason: "kill" });

  // The same devices, reset, under a fresh kernel and memory, and every
  // booted hook again.
  const restart = () => {
    if (exit) return;
    // Messages from the kernel being replaced are dropped by generation, so
    // a reboot reported while restarting comes from the new kernel, which
    // is already halting. Boot again once its hooks have finished.
    if (restarting) {
      reboot_again = true;
      return;
    }
    generation++;
    instance = undefined;
    const current = (restarting = (async () => {
      await terminate_workers();
      await bus.detach();
      if (exit) return;
      await boot_kernel();
      await run_machine_booted(plugins, machine);
    })().then(
      () => {
        if (exit) return;
        restarting = undefined;
        if (reboot_again) {
          reboot_again = false;
          restart();
          return;
        }
        const booted = next_boot;
        next_boot = Promise.withResolvers();
        void next_boot.promise.catch(() => {});
        booted.resolve();
      },
      (error) => {
        if (!exit) fail(error);
      },
    ));
    void current;
  };

  // The kernel's power button. A press before the kernel has registered it
  // is retried for a while; a press during a shutdown already under way, or
  // a second press, does nothing, so the caller just waits.
  const press_button = async (action: "poweroff" | "reboot") => {
    const deadline = performance.now() + 10_000;
    for (;;) {
      const boot = generation;
      const exports = instance?.exports;
      if (!exports) return;
      const result = exports.power_button(
        action === "poweroff" ? PowerButton.PowerOff : PowerButton.Reboot,
      );
      if (result === 0 || result === -EBUSY) return;
      if (result !== -EAGAIN || performance.now() > deadline) {
        throw new Error(`the kernel's power button failed: ${result}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (exit || generation !== boot) return;
    }
  };

  // Waits until no restart is under way, or the machine has ended.
  const settled = async () => {
    while (restarting && !exit) await Promise.race([restarting, exited.promise]);
  };

  const press = async (action: "poweroff" | "reboot") => {
    // A machine between boots is pressed once it has booted again.
    await settled();
    if (exit) return;
    for (const plugin of plugins.toReversed()) {
      if (!plugin.power) continue;
      // A hook that fails has not started anything, so the next one is asked.
      const power = plugin.power;
      if (await (async () => power.call(plugin, action))().catch(() => false)) return;
      if (exit) return;
    }
    await press_button(action);
  };

  // Kills the machine if `done` has not settled in time.
  const deadline = async <T>(timeoutMs: number, done: Promise<T>) => {
    const timer = setTimeout(kill, timeoutMs);
    try {
      return await done;
    } finally {
      clearTimeout(timer);
    }
  };

  const boot_kernel = async () => {
    const { sections, vmlinux, initramfs, memory: memory_type } = await load_resources();
    const boot_generation = generation;
    const pages = kernel_initial_pages(memory_type);
    const allocated = allocate_shared_memory(pages, KERNEL_MEMORY_MAXIMUM_PAGES);
    const { maximum_pages } = allocated;
    const memory = allocated.memory;
    assert(memory.buffer.byteLength === pages * PAGE_SIZE);
    const current = () => !exit && boot_generation === generation;

    const devicetree: DeviceTreeNode = {
      "#address-cells": 1,
      "#size-cells": 1,
      chosen: {
        "rng-seed": crypto.getRandomValues(new Uint8Array(64)),
        bootargs: `console=hvc0 ${configured.args.join(" ")}`,
        ncpus: options.cpus,
      },
      aliases: {},
      memory: {
        device_type: "memory",
        reg: [0, maximum_pages * PAGE_SIZE],
      },
      "reserved-memory": {
        "#address-cells": 1,
        "#size-cells": 1,
        ranges: undefined,
      },
    };

    Object.assign(devicetree, bus.describe());
    (devicetree.chosen as DeviceTreeNode).sections = sections;

    const generated_devicetree = generate_devicetree(devicetree);

    // The imports must exist before instantiation returns the instance they
    // call back into, but they only run once exports.boot() starts the kernel.
    let booted_instance: Instance | undefined;

    const start_worker = (name: string, init: InitMessage | ForwardedInitMessage) => {
      if (!current()) return;
      const pool = workers;
      const worker = platform.spawn_worker(name, {
        on_message(raw) {
          if (!current()) return;
          const message = raw as WorkerMessage;
          switch (message.type) {
            case "spawn_worker":
              try {
                start_worker(message.name, {
                  type: "forwarded_init",
                  port: message.port,
                });
              } catch (error) {
                fail(error);
              }
              break;
            case "boot_console_write":
              boot_console_write(message.message);
              break;
            case "boot_console_close":
              // The kernel's console has taken over. The stream stays open
              // for the early output of the boots after a reboot.
              break;
            case "terminate_machine":
              switch (message.reason) {
                case MachineTerminationReason.Clean:
                  end({ reason: "poweroff" });
                  break;
                case MachineTerminationReason.Panic:
                  fail(new MachinePanicError());
                  break;
                case MachineTerminationReason.Reboot:
                  if (options.reboot === "exit") end({ reason: "reboot" });
                  else restart();
                  break;
                default:
                  fail(new Error(`unknown machine termination reason: ${message.reason}`));
              }
              break;
            case "trigger_irq":
              // A COPY clone or exec successor that has no kernel instance
              // still has to wake the kernel sleeping on its spawn wait.
              assert(booted_instance);
              booted_instance.exports.trigger_irq(message.irq);
              break;
            case "run_on_main":
              assert(booted_instance);
              booted_instance.exports.__indirect_function_table.get(message.fn >>> 0)!(message.arg);
              break;
            case "worker_exit": {
              // The worker closes itself after posting this message. Calling
              // terminate() here races that orderly shutdown and leaks the
              // worker's address-space reservations in WebKit.
              pool.delete(worker);
              break;
            }
            default:
              unreachable(message);
          }
        },
        on_error(error) {
          if (current()) fail(error);
        },
      });
      pool.add(worker);
      worker.post(init, init.type === "forwarded_init" ? [init.port] : undefined);
    };

    const spawn_worker = (
      fn: number,
      arg: number,
      name: string,
      user_memory: UserMemory,
      user: UserContext | null,
    ) => {
      // COPY and EXEC originate only from userspace in a worker; never block
      // the browser's main agent waiting for another worker's allocation.
      assert(user_memory === UserMemory.None || user_memory === UserMemory.Share);
      start_worker(name, {
        type: "init",
        fn,
        arg,
        vmlinux,
        memory,
        user,
        copy: false,
        spawn_wait: null,
        exec: null,
      });
      return 0;
    };

    const unavailable = () => {
      throw new Error("not available on main thread");
    };

    const imports = {
      env: { memory },
      boot: {
        get_devicetree: boot_blob(memory, generated_devicetree, "Device tree"),
        get_initramfs: boot_blob(memory, initramfs, "Built-in initramfs"),
        get_initrd: boot_blob(memory, configured.initramfs, "Initramfs"),
      },
      kernel: kernel_imports({
        is_worker: false,
        memory,
        spawn_worker,
        boot_console_write,
        boot_console_close() {},
        terminate_machine: unavailable,
        run_on_main: unavailable,
        get_user_context: unavailable,
        worker_exit: unavailable,
      }),
      user: {
        compile_begin: unavailable,
        compile_write: unavailable,
        compile_end: unavailable,
        compile_abort: unavailable,
        exec_handoff: unavailable,
        exec_prepare: unavailable,
        exec_instantiate: unavailable,
        unwind: unavailable,
        call: unavailable,
        switch_entry: unavailable,
        call_signal_handler: unavailable,
        rethrow: unavailable,
        call_siginfo_handler: unavailable,
        read: unavailable,
        write: unavailable,
        write_zeroes: unavailable,
        futex_atomic_op: unavailable,
        futex_atomic_cmpxchg: unavailable,
      },
      virtio: bus.attach({
        memory,
        on_error: fail,
        trigger_irq(irq) {
          // A device can complete a request after a kill.
          if (!current()) return;
          assert(booted_instance);
          booted_instance.exports.trigger_irq(irq);
        },
      }),
    } satisfies Imports;

    booted_instance = (await WebAssembly.instantiate(vmlinux, imports)) as Instance;
    if (!current()) return;
    wasm_memory = memory;
    instance = booted_instance;
    booted_instance.exports.boot();
  };

  machine = {
    get memory() {
      return wasm_memory;
    },
    exited: exited.promise,
    kill,
    async shutdown({ timeoutMs = 30_000 }: PowerOptions = {}) {
      // Nothing could start the power-off, so pull the plug.
      if (!exit) void press("poweroff").catch(kill);
      // The deadline also covers a machine that has ended but is still
      // closing its devices, so stuck storage can't hold up the caller.
      return deadline(timeoutMs, exited.promise);
    },
    async reboot({ timeoutMs = 30_000 }: PowerOptions = {}) {
      await deadline(
        timeoutMs,
        (async () => {
          // A reboot under way is finished before this one starts.
          await settled();
          if (exit) throw new Error(`the machine has ended: ${exit.reason}`);
          const booted = next_boot.promise;
          await Promise.all([press("reboot"), booted]);
        })(),
      );
    },
    async [Symbol.asyncDispose]() {
      await machine.shutdown({ timeoutMs: 30_000 });
    },
  };

  try {
    await boot_kernel();
    await run_machine_booted(plugins, machine);
  } catch (error) {
    if (!exit) fail(error);
    await exited.promise;
    throw error;
  }
  return machine;
}
