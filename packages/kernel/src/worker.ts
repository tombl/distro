// SPDX-License-Identifier: MIT

import { listen_endpoint, post_endpoint } from "./endpoint.ts";
import { platform } from "./platform.ts";
import { assert } from "./util.ts";
import { read_wasm_memories } from "./wasm_binary.ts";
import {
  allocate_shared_memory,
  create_halt_error,
  HALT_KERNEL,
  type Imports,
  type Instance,
  uncatchable,
  kernel_imports,
  type MachineTerminationReason,
  memory_bytes,
  user_module_imports_supported,
  type UserContext,
  UserMemory,
  type UserWord,
  user_word_number,
} from "./wasm.ts";

/** A compiled user image whose memory is not allocated yet. */
interface ExecImage {
  module: WebAssembly.Module;
  minimum_pages: number;
  maximum_pages: number;
}

/*
 * Exec runs the new image in a successor worker, so that every worker hosts
 * one user memory for its whole life and ending the worker releases it. A
 * CLONE_VM child's worker hosts its parent's memory, so its first exec swaps
 * in the new memory in place instead (exec_prepare). The two halves of a
 * handoff synchronize through the successor's control array:
 */
/** Whether the successor may enter the kernel: one of the HANDOFF_ values. */
const EXEC_HANDOFF = 0;
const HANDOFF_WAIT = 0;
const HANDOFF_RUN = 1;
const HANDOFF_ABORT = 2;

export interface ExecSuccessor extends ExecImage {
  control: Int32Array<SharedArrayBuffer>;
}

export interface InitMessage {
  type: "init";
  fn: number;
  arg: number;
  vmlinux: WebAssembly.Module;
  memory: WebAssembly.Memory;
  user: UserContext | null;
  /** Set for a COPY clone. */
  copy: boolean;
  /**
   * The kernel's struct wasm_spawn_wait for a COPY clone or an exec
   * successor: this worker stores the result in it and raises its irq.
   */
  spawn_wait: number | null;
  /** Set when this worker succeeds an execing worker. */
  exec: ExecSuccessor | null;
}
export interface ForwardedInitMessage {
  type: "forwarded_init";
  port: MessagePort;
}
export type WorkerMessage =
  | {
      type: "spawn_worker";
      name: string;
      port: MessagePort;
    }
  | { type: "boot_console_write"; message: ArrayBuffer }
  | { type: "boot_console_close" }
  | { type: "terminate_machine"; reason: MachineTerminationReason }
  | { type: "run_on_main"; fn: number; arg: number }
  | { type: "trigger_irq"; irq: number }
  | { type: "worker_exit" };

/** Thrown by user.unwind() to abandon the user stack, caught by user.call(). */
const HALT_USER = create_halt_error("halt user");

const unavailable = () => {
  throw new Error("not available on worker thread");
};

const endpoint = platform.worker_endpoint();
const postMessage = (message: WorkerMessage, transfer?: Transferable[]) =>
  post_endpoint(endpoint, message, transfer);

/** Ends this worker. Kernel code must not run in it afterwards. */
function quit(): void {
  // Messages posted after platform.quit() are not guaranteed to arrive.
  postMessage({ type: "worker_exit" });
  platform.quit();
}

function user_imports({
  kernel_memory,
  get_kernel_instance,
  context,
}: {
  kernel_memory: WebAssembly.Memory;
  get_kernel_instance: () => Instance;
  /**
   * The user image this worker hosts, if any. Exec replaces the worker,
   * except in a CLONE_VM child, whose worker hosts its parent's memory until
   * it execs in place.
   */
  context: UserContext | null;
}): {
  context: UserContext | null;
  prepare(): void;
  /** Moves the image compiled for exec into its successor. */
  take_exec_image(): ExecImage | null;
  /** Records the successor that exec_handoff() starts. */
  set_successor(control: Int32Array<SharedArrayBuffer>): void;
  imports: Imports["user"];
} {
  // Values of enum wasm_handler_result in asm/wasm_imports.h.
  const WASM_HANDLER_ESCAPED = 1;

  let instance: WebAssembly.Instance | null = null;
  let pending_module_bytes: Uint8Array<ArrayBuffer> | null = null;
  let pending_image: ExecImage | null = null;
  /** The image exec_prepare() made ready for an exec in place. */
  let pending_context: UserContext | null = null;
  let pending_instance: WebAssembly.Instance | null = null;
  let successor: Int32Array<SharedArrayBuffer> | null = null;
  // One slot per nested SA_SIGINFO callback; null means its trampoline has
  // not requested the active signal payload yet.
  const siginfo_copy_results: (number | null)[] = [];
  // The exception a signal handler left through, such as a siglongjmp(). It
  // waits here while the kernel returns through the frames of the syscall
  // that delivered the signal, and user.rethrow resumes it beyond them.
  let escape: { error: unknown } | null = null;

  // Runs a handler, catching a wasm exception that would otherwise unwind the
  // kernel frames beneath it without running their epilogues. Only a thrown
  // WebAssembly.Exception, as siglongjmp() and C++ throw make, is an escape.
  // Traps, which may come from a nested syscall's kernel code, and the host's
  // own halts, which abandon those frames on purpose, pass through.
  function run_handler(handler: () => void): boolean {
    try {
      handler();
      return true;
    } catch (error) {
      if (!(error instanceof WebAssembly.Exception)) throw error;
      escape = { error };
      return false;
    }
  }

  function copy_bytes(
    destination_memory: WebAssembly.Memory,
    destination: number,
    source_memory: WebAssembly.Memory,
    source: number,
    length: number,
  ): number {
    const to = memory_bytes(destination_memory, destination, length);
    const from = memory_bytes(source_memory, source, length);
    if (!to || !from) return length;

    try {
      to.set(from);
      return 0;
    } catch {
      return length;
    }
  }

  // How many of the `length` bytes at `address` lie inside user memory. Like
  // a range that runs into an unmapped page, a range that runs off the end
  // of linear memory transfers up to the end: callers such as
  // generic_perform_write() rely on a short copy to make progress.
  function user_extent(address: number, length: number): number {
    assert(context);
    const size = context.memory.buffer.byteLength;
    return address < size ? Math.min(length, size - address) : 0;
  }

  function user_atomic_word(uaddr: number): Int32Array | null {
    const address = uaddr >>> 0;
    if (!context || (address & 3) !== 0) return null;

    const bytes = memory_bytes(context.memory, address, Int32Array.BYTES_PER_ELEMENT);
    return bytes ? new Int32Array(bytes.buffer, bytes.byteOffset, 1) : null;
  }

  function write_kernel_u32(addr: number, value: number): boolean {
    const bytes = memory_bytes(kernel_memory, addr >>> 0, Uint32Array.BYTES_PER_ELEMENT);
    if (!bytes) return false;

    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(0, value, true);
    return true;
  }

  function call_start(): void {
    assert(instance);
    const { _start } = instance.exports;
    assert(typeof _start === "function", "_start not found");
    _start();
    throw new Error("_start reached the end without exiting");
  }
  let call_entry = call_start;

  function instantiate(context: UserContext): WebAssembly.Instance {
    const kernel_instance = get_kernel_instance();
    // Unset while the start function runs, during construction.
    let created: WebAssembly.Instance | null = null;
    created = new WebAssembly.Instance(context.module, {
      env: { memory: context.memory },
      linux: {
        // A direct wasm-to-wasm link with no JS frame. The kernel calls
        // user.unwind when an exec in place replaced this instance.
        syscall: kernel_instance.exports.syscall,
        get_thread_area: kernel_instance.exports.get_thread_area,
        copy_siginfo: (to: UserWord) => {
          const result = kernel_instance.exports.copy_siginfo(to);
          // An image prepared for exec has no handler of its own yet: its
          // start function must not report for the handler that is execing.
          if (instance !== created) return result;
          const current = siginfo_copy_results.length - 1;
          if (current >= 0) siginfo_copy_results[current] = result;
          return result;
        },
      },
    });
    return created;
  }

  function release_successor(state: number) {
    if (!successor) return;
    Atomics.store(successor, EXEC_HANDOFF, state);
    Atomics.notify(successor, EXEC_HANDOFF);
    successor = null;
  }

  // For host work done on top of guest frames. Halts and guest exceptions
  // (C++ throws, longjmp out of a signal handler) keep going; anything else
  // becomes a trap, so the guest cannot catch it and run on.
  function guest_safe(error: unknown): unknown {
    if (error === HALT_USER || error === HALT_KERNEL) return error;
    if (error instanceof WebAssembly.Exception) return error;
    return uncatchable(error);
  }

  // Looks up a guest function pointer the kernel is about to call.
  function user_function(
    fn: UserWord,
    length: number,
    message = "Invalid function signature",
  ): Function {
    assert(instance);

    const { __indirect_function_table } = instance.exports;
    assert(__indirect_function_table instanceof WebAssembly.Table, "Invalid function table");

    const f = __indirect_function_table.get(user_word_number(fn));
    assert(typeof f === "function" && f.length === length, message);
    return f;
  }

  return {
    get context() {
      return context;
    },
    prepare() {
      if (context) instance = instantiate(context);
    },
    take_exec_image() {
      const image = pending_image;
      pending_image = null;
      return image;
    },
    set_successor(control) {
      assert(!successor, "exec successor already spawned");
      successor = control;
    },
    imports: {
      // program management:
      compile_begin(size) {
        pending_module_bytes = null;
        pending_image = null;
        pending_context = null;
        pending_instance = null;
        try {
          pending_module_bytes = new Uint8Array(size >>> 0);
          return 0;
        } catch {
          return -12; // out of memory
        }
      },
      compile_write(buf, offset, size) {
        const source = buf >>> 0;
        const destination = offset >>> 0;
        const length = size >>> 0;
        const kernel_buffer = kernel_memory.buffer;
        if (
          !pending_module_bytes ||
          source > kernel_buffer.byteLength - length ||
          destination > pending_module_bytes.length - length
        ) {
          return -22; // invalid argument
        }
        pending_module_bytes.set(new Uint8Array(kernel_buffer, source, length), destination);
        return 0;
      },
      compile_end(maximum_memory_pages) {
        const bytes = pending_module_bytes;
        pending_module_bytes = null;
        if (!bytes) return -22; // invalid argument

        const rlimit_pages = maximum_memory_pages >>> 0;
        let module: WebAssembly.Module;
        let minimum: number;
        let maximum: number;
        try {
          const memories = read_wasm_memories(bytes);
          const memory_import = memories.imports[0];
          if (
            memories.definitions.length !== 0 ||
            memories.imports.length !== 1 ||
            !memory_import ||
            memory_import.module !== "env" ||
            memory_import.name !== "memory" ||
            memory_import.type.address !== "i32" ||
            !memory_import.type.shared ||
            memory_import.type.maximum === undefined
          ) {
            return -8; // exec format error
          }

          module = new WebAssembly.Module(bytes);
          if (!user_module_imports_supported(module, bytes, memory_import.type.address)) {
            return -8; // exec format error
          }

          minimum = Number(memory_import.type.minimum);
          maximum = Math.min(Number(memory_import.type.maximum), rlimit_pages);
        } catch {
          return -8; // exec format error
        }

        if (maximum < minimum) return -12; // out of memory

        // The worker that uses the memory allocates it, so that it is the
        // only one that ever references it: the successor, or this worker
        // for an exec in place.
        pending_image = { module, minimum_pages: minimum, maximum_pages: maximum };
        return 0;
      },
      compile_abort() {
        pending_module_bytes = null;
        pending_image = null;
        pending_context = null;
        pending_instance = null;
        release_successor(HANDOFF_ABORT);
      },
      exec_handoff() {
        assert(successor, "exec handoff without a successor");
        release_successor(HANDOFF_RUN);
        // The successor now runs on the task's kernel stack.
        quit();
        throw HALT_KERNEL;
      },
      exec_prepare() {
        const image = pending_image;
        pending_image = null;
        if (!image) return -22; // invalid argument
        let next: UserContext;
        try {
          next = {
            module: image.module,
            ...allocate_shared_memory(image.minimum_pages, image.maximum_pages),
          };
        } catch {
          return -12; // out of memory
        }
        // Instantiate now, so that a failure, such as a data segment past
        // the memory, fails the exec rather than the task.
        try {
          pending_instance = instantiate(next);
        } catch {
          return -8; // exec format error
        }
        pending_context = next;
        return 0;
      },
      exec_instantiate() {
        assert(pending_context && pending_instance, "exec in place without a prepared image");
        // Drop the parent's memory; its own worker keeps it alive.
        context = pending_context;
        instance = pending_instance;
        pending_context = null;
        pending_instance = null;
        // An escape from the replaced image has nowhere to go.
        escape = null;
        call_entry = call_start;
      },
      unwind() {
        // The kernel's syscall export calls this once an exec in place has
        // replaced the instance whose frames are still beneath it.
        throw HALT_USER;
      },
      call() {
        try {
          call_entry();
        } catch (error) {
          if (error === HALT_USER) return 1;
          if (error === HALT_KERNEL) throw error;
          console.error("error running user module:", error);
        }
        return 0;
      },
      switch_entry(fn, arg) {
        // This is called if this thread was created by a clone call,
        // so its entrypoint is a user-specified function.
        // The worker prepares an instance sharing the parent's user context
        // before the kernel enters this callback.

        assert(context);

        call_entry = () => {
          user_function(fn, 1)(arg);

          // throw new Error("thread entrypoint reached the end without exiting");
          console.warn("thread entrypoint reached the end without exiting");
        };
      },

      rethrow() {
        // The kernel's syscall export calls this after the syscall that ran
        // an escaping handler has returned through the kernel.
        assert(escape, "no signal handler escape to rethrow");
        const { error } = escape;
        escape = null;
        throw error;
      },

      // signal handling:
      // Signal handlers run on top of the interrupted guest's frames, so a
      // bad handler must not surface there as a catchable error.
      call_signal_handler(fn, sig) {
        try {
          const f = user_function(fn, 1);
          return run_handler(() => f(sig)) ? 0 : WASM_HANDLER_ESCAPED;
        } catch (error) {
          throw guest_safe(error);
        }
      },
      call_siginfo_handler(trampoline, fn, sig) {
        siginfo_copy_results.push(null);
        let halted = false;
        try {
          try {
            const f = user_function(trampoline, 2, "Invalid siginfo trampoline");
            if (!run_handler(() => f(fn, sig))) return WASM_HANDLER_ESCAPED;
          } catch (error) {
            throw guest_safe(error);
          }
          return siginfo_copy_results.at(-1) ?? -22;
        } catch (error) {
          // After exec_handoff(), the successor owns the task: this worker
          // must not run kernel code again.
          halted = error === HALT_KERNEL;
          throw error;
        } finally {
          // Non-local exits can unwind the kernel callback before its C cleanup.
          try {
            if (!halted) get_kernel_instance().exports.clear_siginfo();
          } finally {
            siginfo_copy_results.pop();
          }
        }
      },

      // memory:
      read(to, from, n) {
        const length = n >>> 0;
        if (!context) return length;
        const source = from >>> 0;
        const copied = user_extent(source, length);
        return (
          length - copied + copy_bytes(kernel_memory, to >>> 0, context.memory, source, copied)
        );
      },
      write(to, from, n) {
        const length = n >>> 0;
        if (!context) return length;
        const destination = to >>> 0;
        const copied = user_extent(destination, length);
        return (
          length -
          copied +
          copy_bytes(context.memory, destination, kernel_memory, from >>> 0, copied)
        );
      },
      write_zeroes(to, n) {
        const length = n >>> 0;
        if (!context) return length;
        const address = to >>> 0;
        const cleared = user_extent(address, length);
        const destination = memory_bytes(context.memory, address, cleared);
        if (!destination) return length;

        try {
          destination.fill(0);
          return length - cleared;
        } catch {
          return length;
        }
      },
      futex_atomic_op(oldval, uaddr, op, oparg) {
        const word = user_atomic_word(uaddr);
        if (!word) return -14; // bad address

        let old: number;
        switch (op) {
          case 0: // FUTEX_OP_SET
            old = Atomics.exchange(word, 0, oparg);
            break;
          case 1: // FUTEX_OP_ADD
            old = Atomics.add(word, 0, oparg);
            break;
          case 2: // FUTEX_OP_OR
            old = Atomics.or(word, 0, oparg);
            break;
          case 3: // FUTEX_OP_ANDN
            old = Atomics.and(word, 0, ~oparg);
            break;
          case 4: // FUTEX_OP_XOR
            old = Atomics.xor(word, 0, oparg);
            break;
          default:
            return -38; // function not implemented
        }

        return write_kernel_u32(oldval, old) ? 0 : -14; // bad address
      },
      futex_atomic_cmpxchg(oldval, uaddr, expected, replacement) {
        const word = user_atomic_word(uaddr);
        if (!word) return -14; // bad address

        const old = Atomics.compareExchange(word, 0, expected, replacement);
        return write_kernel_u32(oldval, old) ? 0 : -14; // bad address
      },
    },
  };
}

/**
 * Moves the user context out of the init message, copying it first for a
 * COPY clone or allocating it for an exec successor. Returns undefined if
 * that failed.
 */
function take_user_context(init: InitMessage): UserContext | null | undefined {
  // The event that delivered the message keeps it reachable for the worker's
  // lifetime, so clear the references there.
  const { user, copy, exec } = init;
  init.user = null;
  if (exec) {
    assert(!user && !copy, "exec successor with a user context");
    try {
      return {
        module: exec.module,
        ...allocate_shared_memory(exec.minimum_pages, exec.maximum_pages),
      };
    } catch {
      return undefined;
    }
  }
  if (!user) {
    assert(!copy, "user memory copy without a user context");
    return null;
  }
  user.memory.grow(0);
  if (!copy) return user;

  // fork.c permits COPY only for a single-user mm, and the parent sleeps in
  // the kernel until this worker reports, so the source is stable. Allocate
  // here so the private backing store is owned by the destination isolate,
  // not the long-lived parent.
  try {
    const source = memory_bytes(user.memory, 0);
    if (!source) throw new RangeError("invalid source memory");
    const copied = allocate_shared_memory(source.byteLength / 0x10000, user.maximum_pages);
    const destination = memory_bytes(copied.memory, 0, source.byteLength);
    if (!destination) throw new RangeError("invalid destination memory");
    destination.set(source);
    return { module: user.module, ...copied };
  } catch {
    return undefined;
  }
}

/**
 * Reports a COPY clone's or exec successor's result to the kernel, which is
 * sleeping on the spawn wait: store it, then raise the wait's irq.
 */
function report_spawn(
  memory: WebAssembly.Memory,
  wait: number,
  status: number,
  instance?: Instance,
) {
  const words = new Int32Array(memory.buffer, wait >>> 0, 2);
  const irq = words[1]!;
  Atomics.store(words, 0, status);
  if (instance) instance.exports.trigger_irq(irq);
  // Without a kernel instance, the page raises it.
  else postMessage({ type: "trigger_irq", irq });
}

function start(init: InitMessage) {
  const { fn, arg, vmlinux, memory, exec, spawn_wait } = init;
  // Refresh every WebAssembly.Memory received across a worker boundary
  // immediately, including any future additions to InitMessage. Chromium can
  // retain the fixed-length buffer wrapper captured before another isolate
  // grows it; grow(0) refreshes the wrapper before constructing any views.
  memory.grow(0);

  // A failed copy or allocation fails the clone or execve with ENOMEM, before
  // execve's point of no return.
  const context = take_user_context(init);
  const user = user_imports({
    kernel_memory: memory,
    get_kernel_instance: () => instance,
    context: context ?? null,
  });
  let instance: Instance;
  try {
    instance = new WebAssembly.Instance(vmlinux, worker_imports(init, user)) as Instance;
  } catch (error) {
    if (spawn_wait === null) throw error;
    report_spawn(memory, spawn_wait, -12);
    quit();
    return;
  }
  try {
    if (context === undefined) throw new RangeError("user memory allocation failed");
    user.prepare();
  } catch (error) {
    if (spawn_wait === null) throw error;
    report_spawn(memory, spawn_wait, -12, instance);
    quit();
    return;
  }
  if (spawn_wait !== null) report_spawn(memory, spawn_wait, 1, instance);

  if (exec) {
    // The execing worker still runs on the task's kernel stack. Wait in JS,
    // so this worker runs no kernel code until that worker has left.
    let handoff: number;
    while ((handoff = Atomics.load(exec.control, EXEC_HANDOFF)) === HANDOFF_WAIT) {
      Atomics.wait(exec.control, EXEC_HANDOFF, HANDOFF_WAIT);
    }
    if (handoff !== HANDOFF_RUN) {
      quit();
      return;
    }
  }

  try {
    instance.exports.__indirect_function_table.get(fn >>> 0)!(arg);
  } catch (error) {
    if (error === HALT_KERNEL) return;
    throw error;
  }
}

function worker_imports({ vmlinux, memory }: InitMessage, user: ReturnType<typeof user_imports>) {
  return {
    env: { memory },
    boot: {
      get_devicetree: unavailable,
      get_initramfs: unavailable,
    },
    user: user.imports,
    kernel: kernel_imports({
      is_worker: true,
      memory,
      spawn_worker(fn, arg, name, user_memory, context, spawn_wait) {
        let exec: ExecSuccessor | null = null;
        if (user_memory === UserMemory.Exec) {
          const image = user.take_exec_image();
          if (!image) return -22; // invalid argument
          exec = { ...image, control: new Int32Array(new SharedArrayBuffer(4)) };
        }

        const direct = new MessageChannel();
        postMessage(
          {
            type: "spawn_worker",
            name,
            port: direct.port1,
          },
          [direct.port1],
        );
        direct.port2.postMessage({
          type: "init",
          fn,
          arg,
          vmlinux,
          memory,
          user: context,
          copy: user_memory === UserMemory.Copy,
          spawn_wait,
          exec,
        } satisfies InitMessage);

        // Never wait here: the new worker may not start until another worker
        // exits. For COPY and EXEC the kernel sleeps on spawn_wait, which the
        // new worker completes; an exec that fails later aborts the successor.
        if (exec) user.set_successor(exec.control);
        return 0;
      },
      boot_console_write(message) {
        postMessage({ type: "boot_console_write", message });
      },
      boot_console_close() {
        postMessage({ type: "boot_console_close" });
      },
      terminate_machine(reason) {
        postMessage({ type: "terminate_machine", reason });
      },
      run_on_main(fn, arg) {
        postMessage({ type: "run_on_main", fn, arg });
      },
      get_user_context() {
        return user.context;
      },
      worker_exit() {
        postMessage({ type: "worker_exit" });
      },
    }),
    virtio: {
      set_features: unavailable,
      setup: unavailable,
      reset: unavailable,
      enable_vring: unavailable,
      disable_vring: unavailable,
      notify: unavailable,
    },
  } satisfies Imports;
}

listen_endpoint(endpoint, {
  message(raw) {
    const message = raw as InitMessage | ForwardedInitMessage;

    // Initial workers receive InitMessage directly from the page. Workers
    // spawned by another worker receive their InitMessage over this port, which
    // works around a WebKit bug reclaiming shared Wasm memory across JS VMs.
    if (message.type === "forwarded_init") {
      const { port } = message;
      const stop_listening = listen_endpoint(port, {
        message(data) {
          stop_listening();
          port.close();
          start(data as InitMessage);
        },
      });
      port.start();
      return;
    }

    start(message);
  },
});
