// SPDX-License-Identifier: MIT

import { type DeviceTreeNode, generate_devicetree } from "./devicetree.ts";
import { platform, type WorkerHandle } from "./platform.ts";
import { configure_machine, run_machine_booted, run_machine_closing } from "./plugin-internal.ts";
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
  type UserContext,
  UserMemory,
} from "./wasm.ts";
import type { ForwardedInitMessage, InitMessage, WorkerMessage } from "./worker.ts";

export { bootConsole } from "./plugin.ts";
export type { Device } from "./virtio/device.ts";
export { blockDevice, type BlockDeviceOptions, type BlockStorage } from "./virtio/block.ts";
export { type Endpoint, serveDevice, serveDeviceError, workerDevice } from "./virtio/remote.ts";
export { type ConsoleDevice, consoleDevice } from "./virtio/console.ts";
export { entropyDevice } from "./virtio/entropy.ts";
export {
  type FS,
  type FSAttributes,
  type FSCreateContext,
  type FSDirectoryEntry,
  type FSDeviceOptions,
  FSError,
  type FSErrorCode,
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
   * PROTOTYPE (redesign phase 0 spike). What a guest reboot does: boot the
   * same devices again (the default, like QEMU), or end the machine with
   * exit reason "reboot" (like QEMU's -no-reboot).
   */
  reboot?: "restart" | "exit";
}

/** PROTOTYPE: how a machine ended. */
export type MachineExit =
  | { reason: "poweroff" | "kill" | "reboot" }
  | { reason: "crash"; error: unknown };

/**
 * A booted Linux machine: one shared WebAssembly memory, one Web Worker per
 * virtual CPU, and its virtio devices.
 */
export interface Machine extends Disposable, AsyncDisposable {
  /** The machine's physical memory. */
  readonly memory: WebAssembly.Memory;
  /** Settles when closed, rejecting if the machine failed unexpectedly. */
  readonly closed: Promise<void>;
  /**
   * Idempotently shuts down the workers and owned devices, after running the
   * plugins' `closing` hooks. Returns before the hooks finish, as does
   * `Symbol.dispose`; use `await using` or await `closed` for a durable
   * shutdown.
   *
   * Teardown normally waits for in-flight device requests. If a closing hook
   * rejects, teardown is forced: workers are terminated without waiting, so a
   * device whose storage call never settles never runs its own `close()`, and
   * `closed` rejects with the hook's error.
   */
  close(): void;
  /** PROTOTYPE: settles once the machine has ended, and never rejects. */
  readonly exited: Promise<MachineExit>;
  /**
   * PROTOTYPE: presses the power button. Plugins' `power` hooks are asked in
   * reverse order, then the kernel's own button, which runs the image's
   * /sbin/poweroff. Kills the machine after the timeout.
   */
  shutdown(options?: { timeoutMs?: number }): Promise<MachineExit>;
  /** PROTOTYPE: an orderly reboot, which resolves once booted again. */
  reboot(options?: { timeoutMs?: number }): Promise<void>;
  /** PROTOTYPE: pulls the plug. */
  kill(): void;
}

export class MachinePanicError extends Error {
  constructor() {
    super("kernel panic");
    this.name = "MachinePanicError";
  }
}

async function read_resources() {
  const { bytes, module: vmlinux } = await platform.load_wasm(
    new URL("../vmlinux.wasm", import.meta.url),
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
  const workers = new Set<WorkerHandle>();
  // PROTOTYPE: each boot is a generation; a rebooted machine ignores
  // whatever the previous kernel's workers still post.
  let generation = 0;
  let exit: MachineExit | undefined;
  const exited = Promise.withResolvers<MachineExit>();
  let closed = false;
  let failed = false;
  let finish_error: unknown;
  let finish_promise: Promise<void> | undefined;

  const closed_promise = Promise.withResolvers<void>();
  // Lifecycle promises on platform objects do not cause unhandled rejections
  // merely because a consumer chooses not to observe them.
  void closed_promise.promise.catch(() => {});

  const boot_console_write = (message: ArrayBuffer) => {
    // Boot output is diagnostic and synchronous from the kernel's point of
    // view. Discard it unless a plugin attached a reader before boot.
    if (!boot_console_closed && boot_console.locked) {
      boot_console_controller.enqueue(new Uint8Array(message));
    }
  };
  // A forced teardown stops waiting for device close, which waits for
  // in-flight requests that may be stuck in host storage forever. It can be
  // requested after an ordinary teardown has already started.
  const force_requested = Promise.withResolvers<void>();
  let forced = false;
  // Idempotent: a device request that settles after a forced teardown can
  // still reach fail(), which must then be a no-op.
  const finish = (force = false) => {
    if (force && !forced) {
      forced = true;
      force_requested.resolve();
    }
    if (finish_promise) return finish_promise;
    closed = true;
    finish_promise = (async () => {
      const device_close = bus.close().catch((device_error) => {
        if (!failed && !forced) {
          failed = true;
          finish_error = device_error;
        }
      });
      await Promise.race([device_close, force_requested.promise]);
      try {
        await Promise.all(Array.from(workers, (worker) => worker.terminate()));
      } catch (termination_error) {
        if (!failed) {
          failed = true;
          finish_error = termination_error;
        }
      }
      boot_console_close();
      exited.resolve(
        failed ? { reason: "crash", error: finish_error } : (exit ?? { reason: "kill" }),
      );
      if (failed) closed_promise.reject(finish_error);
      else closed_promise.resolve();
    })();
    return finish_promise;
  };
  const fail = (error: unknown, force = false) => {
    if (!failed) {
      failed = true;
      finish_error = error;
    }
    return finish(force);
  };
  let closing = false;
  const close = () => {
    if (closing || closed) return;
    closing = true;
    // A guest that powers off or fails while plugins are closing has already
    // finished the machine; only an orderly close reports a closing failure.
    void run_machine_closing(plugins).then(
      () => finish(),
      // Either way, a failed hook forces a teardown that may be stuck.
      (error) => (closed ? finish(true) : fail(error, true)),
    );
  };

  // The imports must exist before instantiation returns the instance they
  // call back into, but they only run once exports.boot() starts the kernel.
  let instance: Instance | undefined;
  let wasm_memory!: WebAssembly.Memory;
  let machine!: Machine;
  let rebooting = false;
  let rebooted = Promise.withResolvers<void>();
  void rebooted.promise.catch(() => {});

  const kill = () => {
    exit ??= { reason: "kill" };
    void finish(true);
  };

  // PROTOTYPE: the same devices, a fresh kernel and memory, and every
  // booted hook again.
  const restart = () => {
    if (closed || rebooting) return;
    rebooting = true;
    generation++;
    void (async () => {
      await Promise.all(Array.from(workers, (worker) => worker.terminate()));
      workers.clear();
      await bus.detach();
      await boot_kernel();
      await run_machine_booted(plugins, machine);
    })().then(
      () => {
        rebooting = false;
        const done = rebooted;
        rebooted = Promise.withResolvers();
        void rebooted.promise.catch(() => {});
        done.resolve();
      },
      (error) => {
        rebooting = false;
        rebooted.reject(error);
        void fail(error);
      },
    );
  };

  const press = async (action: "poweroff" | "reboot") => {
    for (const plugin of plugins.toReversed()) if (await plugin.power?.(action)) return;
    const result = instance?.exports.power_button?.(action === "poweroff" ? 1 : 2);
    if (result !== 0) throw new Error(`the kernel's power button is unavailable (${result})`);
  };

  const boot_kernel = async () => {
    const { sections, vmlinux, initramfs, memory: memory_type } = await load_resources();
    const boot_generation = generation;
    const pages = kernel_initial_pages(memory_type);
    const allocated = allocate_shared_memory(pages, KERNEL_MEMORY_MAXIMUM_PAGES);
    const { maximum_pages } = allocated;
    wasm_memory = allocated.memory;
    assert(wasm_memory.buffer.byteLength === pages * PAGE_SIZE);

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

    const start_worker = (name: string, init: InitMessage | ForwardedInitMessage) => {
      if (closed || boot_generation !== generation) return;
      const worker = platform.spawn_worker(name, {
        on_message(raw) {
          const message = raw as WorkerMessage;
          if (boot_generation !== generation) return;
          switch (message.type) {
            case "spawn_worker":
              try {
                start_worker(message.name, {
                  type: "forwarded_init",
                  port: message.port,
                });
              } catch (error) {
                void fail(error);
              }
              break;
            case "boot_console_write":
              boot_console_write(message.message);
              break;
            case "boot_console_close":
              boot_console_close();
              break;
            case "terminate_machine":
              switch (message.reason) {
                case MachineTerminationReason.Clean:
                  exit ??= { reason: "poweroff" };
                  void finish();
                  break;
                case MachineTerminationReason.Panic:
                  void fail(new MachinePanicError());
                  break;
                case MachineTerminationReason.Reboot:
                  if (options.reboot === "exit") {
                    exit ??= { reason: "reboot" };
                    void finish();
                  } else {
                    restart();
                  }
                  break;
                default:
                  void fail(new Error(`unknown machine termination reason: ${message.reason}`));
              }
              break;
            case "trigger_irq":
              // A COPY clone or exec successor that has no kernel instance
              // still has to wake the kernel sleeping on its spawn wait.
              assert(instance);
              instance.exports.trigger_irq(message.irq);
              break;
            case "run_on_main":
              assert(instance);
              instance.exports.__indirect_function_table.get(message.fn >>> 0)!(message.arg);
              break;
            case "worker_exit": {
              // The worker closes itself after posting this message. Calling
              // terminate() here races that orderly shutdown and leaks the
              // worker's address-space reservations in WebKit.
              workers.delete(worker);
              break;
            }
            default:
              unreachable(message);
          }
        },
        on_error: fail,
      });
      workers.add(worker);
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
        memory: wasm_memory,
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
      env: { memory: wasm_memory },
      boot: {
        get_devicetree: boot_blob(wasm_memory, generated_devicetree, "Device tree"),
        get_initramfs: boot_blob(wasm_memory, initramfs, "Built-in initramfs"),
        get_initrd: boot_blob(wasm_memory, configured.initramfs, "Initramfs"),
      },
      kernel: kernel_imports({
        is_worker: false,
        memory: wasm_memory,
        spawn_worker,
        boot_console_write,
        boot_console_close,
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
        memory: wasm_memory,
        on_error: fail,
        trigger_irq(irq) {
          assert(instance);
          instance.exports.trigger_irq(irq);
        },
      }),
    } satisfies Imports;

    instance = (await WebAssembly.instantiate(vmlinux, imports)) as Instance;
    instance.exports.boot();
  };

  machine = {
    get memory() {
      return wasm_memory;
    },
    closed: closed_promise.promise,
    exited: exited.promise,
    close,
    kill,
    async shutdown({ timeoutMs = 30_000 } = {}) {
      if (!closed) {
        await press("poweroff").catch(kill);
        const timer = setTimeout(kill, timeoutMs);
        await exited.promise;
        clearTimeout(timer);
      }
      return exited.promise;
    },
    async reboot({ timeoutMs = 30_000 } = {}) {
      const next = rebooted.promise;
      await press("reboot");
      const timer = setTimeout(kill, timeoutMs);
      try {
        await Promise.race([
          next,
          exited.promise.then((ended) => {
            throw new Error(`machine ended instead of rebooting: ${ended.reason}`);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    [Symbol.dispose]: close,
    async [Symbol.asyncDispose]() {
      close();
      await closed_promise.promise;
    },
  };

  try {
    await boot_kernel();
    await run_machine_booted(plugins, machine);
    return machine;
  } catch (error) {
    await finish();
    throw error;
  }
}
