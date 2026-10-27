// SPDX-License-Identifier: MIT

import { platform } from "./platform.ts";
import { read_wasm_function_imports } from "./wasm_binary.ts";

export interface Instance extends WebAssembly.Instance {
  exports: {
    __indirect_function_table: WebAssembly.Table;
    boot(): void;
    trigger_irq(irq: number): void;
    // Linked directly into each user instance as linux.syscall, so a syscall
    // never passes through JS. The number, every argument slot and the result
    // are user words.
    syscall(
      nr: UserWord,
      arg0: UserWord,
      arg1: UserWord,
      arg2: UserWord,
      arg3: UserWord,
      arg4: UserWord,
      arg5: UserWord,
    ): UserWord;
    get_thread_area(): UserWord;
    copy_siginfo(to: UserWord): number;
    clear_siginfo(): void;
  };
}

export interface UserContext {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  // The JS API cannot recover a memory's maximum after construction.
  maximum_pages: number;
}

const supported_user_module_imports = new Set([
  "env\0memory\0memory",
  "linux\0syscall\0function",
  "linux\0get_thread_area\0function",
  "linux\0copy_siginfo\0function",
]);

/**
 * The address type of a user memory. Pointers, longs and syscall argument
 * slots cross the user ABI at this width.
 */
export type UserWidth = "i32" | "i64";

/**
 * A pointer or long crossing the user ABI: a number where the user width is
 * i32, and a bigint where it is i64.
 */
export type UserWord = number | bigint;

/** Converts a user word, such as a function table index, to a number. */
export function user_word_number(word: UserWord): number {
  return typeof word === "bigint" ? Number(word) : word >>> 0;
}

// The signature of each kernel function a user module may import. A 64-bit
// syscall argument spans two slots where the width is i32; the kernel's
// asm/syscall_wrapper.h reassembles it.
function user_module_function_types(width: UserWidth) {
  return new Map([
    ["linux\0syscall", `${Array(7).fill(width).join(",")}->${width}`],
    ["linux\0get_thread_area", `->${width}`],
    ["linux\0copy_siginfo", `${width}->i32`],
  ]);
}

/**
 * Whether every import can be supplied when a userspace module of the given
 * width is instantiated. A binary built for another ABI fails here, so exec
 * reports ENOEXEC rather than failing to link after the point of no return.
 */
export function user_module_imports_supported(
  module: WebAssembly.Module,
  bytes: Uint8Array,
  width: UserWidth,
): boolean {
  const function_types = user_module_function_types(width);
  return (
    WebAssembly.Module.imports(module).every(({ module, name, kind }) =>
      supported_user_module_imports.has(`${module}\0${name}\0${kind}`),
    ) &&
    read_wasm_function_imports(bytes).every(
      ({ module, name, type }) => function_types.get(`${module}\0${name}`) === type,
    )
  );
}

/**
 * Allocates a shared memory, halving the maximum whenever the engine refuses
 * to reserve that much address space, degrading as far as the initial size.
 */
export function allocate_shared_memory(
  initial_pages: number,
  preferred_maximum_pages: number,
  allocate: (descriptor: WebAssembly.MemoryDescriptor) => WebAssembly.Memory = (descriptor) =>
    new WebAssembly.Memory(descriptor),
): { memory: WebAssembly.Memory; maximum_pages: number } {
  let maximum_pages = preferred_maximum_pages;
  for (;;) {
    try {
      return {
        memory: allocate({
          initial: initial_pages,
          maximum: maximum_pages,
          shared: true,
        }),
        maximum_pages,
      };
    } catch (error) {
      const smaller_maximum = Math.max(initial_pages, Math.floor(maximum_pages / 2));
      if (!(error instanceof RangeError) || smaller_maximum >= maximum_pages) {
        throw error;
      }
      maximum_pages = smaller_maximum;
    }
  }
}

/*
 * Read memory.buffer immediately before constructing a view so growth in
 * another worker is visible. Turn invalid bounds and host exceptions into an
 * ordinary failure result for kernel copy helpers.
 *
 * Omitting length returns the remainder of the current memory. Fork uses this
 * to derive the child's initial page count and bytes from the same view.
 */
export function memory_bytes(
  memory: WebAssembly.Memory,
  address: number,
  length?: number,
): Uint8Array<ArrayBufferLike> | null {
  try {
    const buffer = memory.buffer;
    const view_length = length ?? buffer.byteLength - address;
    if (
      !Number.isSafeInteger(address) ||
      !Number.isSafeInteger(view_length) ||
      address < 0 ||
      view_length < 0 ||
      view_length > buffer.byteLength ||
      address > buffer.byteLength - view_length
    ) {
      return null;
    }
    return new Uint8Array(buffer, address, view_length);
  } catch {
    return null;
  }
}

/** Values for the kernel.spawn_worker guest/host ABI. */
export const UserMemory = {
  /** A kernel thread, with no user context. */
  None: 0,
  /** A CLONE_VM thread, sharing the spawning worker's user context. */
  Share: 1,
  /** A fork, snapshotting the spawning worker's user context. */
  Copy: 2,
  /** The spawning worker's successor, running the image it is execing. */
  Exec: 3,
} as const;

/** Values for the kernel.spawn_worker guest/host ABI. */
export type UserMemory = (typeof UserMemory)[keyof typeof UserMemory];

/** Values for the kernel.terminate_machine guest/host ABI. */
export const MachineTerminationReason = {
  Clean: 0,
  Panic: 1,
} as const;

/** Values for the kernel.terminate_machine guest/host ABI. */
export type MachineTerminationReason =
  (typeof MachineTerminationReason)[keyof typeof MachineTerminationReason];

export interface Imports {
  env: { memory: WebAssembly.Memory };
  boot: {
    get_devicetree(buf: number, size: number): number;
    get_initramfs(buf: number, size: number): number;
  };
  kernel: {
    breakpoint(): void;
    halt_worker(): void;
    /** Reports that the whole machine ended, rather than only this worker. */
    terminate_machine(reason: MachineTerminationReason): void;
    boot_console_write(msg: number, len: number): void;
    boot_console_close(): void;
    return_address(_level: number): number;
    /** Unix time in nanoseconds, monotonically advancing during this session. */
    get_now_nsec(): bigint;
    get_stacktrace(buf: number, size: number): void;
    spawn_worker(
      fn: number,
      arg: number,
      comm: number,
      comm_len: number,
      user_memory: number,
      /** A struct wasm_spawn_wait for COPY and EXEC, else 0. */
      wait: number,
    ): number;
    run_on_main(fn: number, arg: number): void;
  };
  user: {
    compile_begin(size: number): number;
    compile_write(buf: number, offset: number, size: number): number;
    compile_end(maximum_memory_pages: number): number;
    compile_abort(): void;
    /**
     * Starts the successor spawned for the compiled image, then ends this
     * worker without returning.
     */
    exec_handoff(): void;
    call(): void;
    switch_entry(fn: UserWord, arg: UserWord): void;
    /** Returns WASM_HANDLER_ESCAPED if the handler left through an exception. */
    call_signal_handler(fn: UserWord, sig: number): number;
    /**
     * Returns WASM_HANDLER_ESCAPED if the handler left through an exception,
     * and otherwise the result of its siginfo copy.
     */
    call_siginfo_handler(trampoline: UserWord, fn: UserWord, sig: number): number;
    /** Throws the exception a signal handler escaped with. */
    rethrow(): never;
    read(to: number, from: number, n: number): number;
    write(to: number, from: number, n: number): number;
    write_zeroes(to: number, n: number): number;
    futex_atomic_op(oldval: number, uaddr: number, op: number, oparg: number): number;
    futex_atomic_cmpxchg(
      oldval: number,
      uaddr: number,
      expected: number,
      replacement: number,
    ): number;
  };
  virtio: {
    set_features(dev: number, features: bigint): void;

    setup(dev: number, config_irq: number, config_addr: number, config_len: number): void;
    /** `done` is a guest word set to 1 once the device has finished with guest memory. */
    reset(dev: number, done: number): void;

    enable_vring(dev: number, vq: number, size: number, desc_addr: number, irq: number): void;
    disable_vring(dev: number, vq: number): void;

    notify(dev: number, vq: number): void;
  };
}

// A JS value thrown through a guest built with wasm exception handling can be
// caught by C++ catch (...) or a cleanup pad. A real wasm trap retains its
// uncatchable status when rethrown from a host import.
const halt_trap = new WebAssembly.Instance(
  new WebAssembly.Module(
    Uint8Array.from([
      // (module (func (export "trap") unreachable))
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03,
      0x02, 0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x74, 0x72, 0x61, 0x70, 0x00, 0x00, 0x0a, 0x05,
      0x01, 0x03, 0x00, 0x00, 0x0b,
    ]),
  ),
).exports.trap as () => void;

export function create_halt_error(label: string): WebAssembly.RuntimeError {
  try {
    halt_trap();
  } catch (error) {
    const trap = error as WebAssembly.RuntimeError;
    trap.message = label;
    return trap;
  }
  throw new Error("halt trap returned");
}

export const HALT_KERNEL = create_halt_error("halt kernel");

// Host failures raised while guest frames are on the stack must not resume the
// guest either: rethrow them as traps, keeping the original as the cause.
export function uncatchable(error: unknown): WebAssembly.RuntimeError {
  const trap = create_halt_error(error instanceof Error ? error.message : String(error));
  trap.cause = error;
  return trap;
}

export function kernel_imports({
  is_worker,
  memory,
  spawn_worker,
  boot_console_write,
  boot_console_close,
  terminate_machine,
  run_on_main,
  get_user_context,
  worker_exit,
}: {
  is_worker: boolean;
  memory: WebAssembly.Memory;
  spawn_worker: (
    fn: number,
    arg: number,
    name: string,
    user_memory: UserMemory,
    user: UserContext | null,
    /** Where a COPY clone or exec successor reports its result. */
    spawn_wait: number | null,
  ) => number;
  boot_console_write: (message: ArrayBuffer) => void;
  boot_console_close: () => void;
  terminate_machine: (reason: MachineTerminationReason) => void;
  run_on_main: (fn: number, arg: number) => void;
  get_user_context: () => UserContext | null;
  /** Reports that this worker's kernel thread halted and the worker is closing. */
  worker_exit: () => void;
}): Imports["kernel"] {
  return {
    breakpoint: () => {
      debugger;
    },
    halt_worker: () => {
      if (!is_worker) throw new Error("Halt called in main thread");
      // Messages posted after platform.quit() are not guaranteed to arrive.
      worker_exit();
      platform.quit();
      throw HALT_KERNEL;
    },
    terminate_machine: (reason) => {
      if (!is_worker) {
        throw new Error("Machine termination called in main thread");
      }
      terminate_machine(reason);
      throw HALT_KERNEL;
    },

    boot_console_write: (msg, len) => {
      const address = msg >>> 0;
      const length = len >>> 0;
      boot_console_write(new Uint8Array(memory.buffer, address, length).slice().buffer);
    },
    boot_console_close,

    return_address: (_level) => {
      return 0;
    },

    get_now_nsec: () => {
      /*
        The more straightforward way to do this is
        `BigInt(Math.round(performance.now() * 1_000_000))`.
        Below is semantically identical but has less floating point
        inaccuracy.
        `performance.now()` has 5μs precision in the browser.
        In server runtimes it has full nanosecond precision, but this code
        rounds to the same 5μs precision.
      */
      return BigInt(Math.round((performance.now() + performance.timeOrigin) * 200)) * 5000n;
    },

    get_stacktrace: (buf, size) => {
      const address = buf >>> 0;
      const capacity = size >>> 0;
      // 5 lines: strip Error, strip 4 common lines of stack
      const trace = new TextEncoder().encode(new Error().stack?.split("\n").slice(5).join("\n"));
      if (trace.byteLength > capacity && capacity >= 3) {
        /// 46 = "."
        trace[capacity - 1] = 46;
        trace[capacity - 2] = 46;
        trace[capacity - 3] = 46;
      }
      new Uint8Array(memory.buffer).set(trace.subarray(0, capacity), address);
    },

    spawn_worker: (fn, arg, comm, comm_len, user_memory, wait) => {
      const comm_address = comm >>> 0;
      const comm_length = comm_len >>> 0;
      const name = new TextDecoder().decode(
        new Uint8Array(memory.buffer, comm_address, comm_length).slice(), // copy to transfer to non-shared backing
      );
      switch (user_memory) {
        case UserMemory.None:
          return spawn_worker(fn, arg, name, user_memory, null, null);
        case UserMemory.Exec:
          if (!wait) return -22; // invalid argument
          return spawn_worker(fn, arg, name, user_memory, null, wait >>> 0);
        case UserMemory.Share:
        case UserMemory.Copy: {
          const context = get_user_context();
          if (!context) return -22; // invalid argument
          if (user_memory === UserMemory.Share) {
            return spawn_worker(fn, arg, name, user_memory, context, null);
          }
          if (!wait) return -22; // invalid argument
          return spawn_worker(fn, arg, name, user_memory, context, wait >>> 0);
        }
        default:
          return -22; // invalid argument
      }
    },

    run_on_main,
  };
}
