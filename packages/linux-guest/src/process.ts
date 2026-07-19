// ChildProcess: a spawned guest process as a JS object. The agent only
// spawns and reaps; stdio and signals are plain injected syscalls on the
// pipe fds spawn returned.

import { E, SIG, SystemError, WEXITSTATUS, WIFEXITED, WIFSIGNALED, WTERMSIG } from "./abi.ts";
import type { GuestSession } from "./conn.ts";
import { CHUNK, type GuestFd, kill, read, reap, write } from "./syscalls.ts";

/** A signal that can be sent to a guest process with `ChildProcess.kill`. */
export type Signal =
  | "SIGHUP"
  | "SIGINT"
  | "SIGQUIT"
  | "SIGKILL"
  | "SIGTERM"
  | "SIGUSR1"
  | "SIGUSR2";

const signal_numbers: Record<Signal, number> = {
  SIGHUP: SIG.HUP,
  SIGINT: SIG.INT,
  SIGQUIT: SIG.QUIT,
  SIGKILL: SIG.KILL,
  SIGTERM: SIG.TERM,
  SIGUSR1: SIG.USR1,
  SIGUSR2: SIG.USR2,
};

const signal_names = new Map<number, Signal>(
  Object.entries(signal_numbers).map(([name, number]) => [number, name as Signal]),
);

/**
 * How a guest process ended.
 *
 * A process killed by a signal reports the signal and a `code` of `0`, so
 * check `success` rather than decoding the pair.
 */
export interface CommandStatus {
  /** The process exited with code 0. */
  readonly success: boolean;
  /** The exit code. */
  readonly code: number;
  /** The signal that killed the process, or `null` if it exited. */
  readonly signal: Signal | number | null;
}

export interface ChildProcessInit {
  session: GuestSession;
  pid: number;
  stdin: GuestFd;
  stdout: GuestFd;
  stderr: GuestFd;
  signal?: AbortSignal;
  /** Returns the process slot client.ts acquired; called exactly once, when
   *  the reap settles, because until then this process may hold blocked
   *  lanes. */
  release: () => void;
}

/**
 * A guest process spawned by `guest.exec`.
 *
 * `stdin` is a `WritableStream`, `stdout` and `stderr` are
 * `ReadableStream`s, and `status` resolves when the process exits. The
 * process is an async disposable, so `await using` kills it and waits for
 * it to be reaped when the block ends.
 */
export class ChildProcess implements AsyncDisposable {
  /** Process ID in the guest. */
  readonly pid: number;
  /**
   * A `WritableStream<Uint8Array>` connected to the process's stdin. Close
   * it to send EOF, which is how programs such as `cat` know to finish.
   *
   * Writes are buffered on the host side, so filling stdin before reading
   * stdout does not deadlock, even once the guest's pipe is full.
   *
   * @example Feed input to a command
   * ```ts
   * const process = await guest.exec(["cat"]);
   * const writer = process.stdin.getWriter();
   * await writer.write(new TextEncoder().encode("hello from the page\n"));
   * await writer.close();
   * console.log(await new Response(process.stdout).text());
   * ```
   */
  readonly stdin: WritableStream<Uint8Array>;
  /**
   * The process's standard output, as a `ReadableStream<Uint8Array>`.
   * `new Response(process.stdout).text()` collects the whole output;
   * iterate the stream to handle output as it arrives.
   *
   * @example Stream output as it arrives
   * ```ts
   * const process = await guest.exec([
   *   "sh",
   *   "-c",
   *   "for i in 1 2 3; do echo line $i; sleep 1; done",
   * ]);
   * for await (const chunk of process.stdout) {
   *   console.log(new TextDecoder().decode(chunk));
   * }
   * ```
   */
  readonly stdout: ReadableStream<Uint8Array>;
  /** The process's standard error, as a `ReadableStream<Uint8Array>`. */
  readonly stderr: ReadableStream<Uint8Array>;
  /**
   * Resolves to the process's `CommandStatus` when it exits. If the process
   * was aborted through the `signal` exec option, rejects with the abort
   * reason instead.
   *
   * @example Check how a command ended
   * ```ts
   * const process = await guest.exec(["sh", "-c", "exit 37"]);
   * console.log(await process.status);
   * // { success: false, code: 37, signal: null }
   * ```
   */
  readonly status: Promise<CommandStatus>;

  readonly #session: GuestSession;
  readonly #stdin: GuestFd;
  readonly #stdout: GuestFd;
  readonly #stderr: GuestFd;

  #close?: Promise<void>;
  #aborted = false;
  #abort_reason: unknown;
  #remove_abort = () => {};
  #stdin_tail: Promise<void> = Promise.resolve();
  #stdin_error: unknown = null;

  constructor(init: ChildProcessInit) {
    const { session, pid, stdin, stdout, stderr, signal, release } = init;
    this.pid = pid;
    this.#session = session;
    this.#stdin = stdin;
    this.#stdout = stdout;
    this.#stderr = stderr;

    const pump = async (data: Uint8Array) => {
      let offset = 0;
      while (offset < data.byteLength) {
        const written = await write(stdin, data.subarray(offset, offset + CHUNK));
        if (written === 0) throw new SystemError(E.IO);
        offset += written;
      }
    };
    this.stdin = new WritableStream({
      write: (chunk) => {
        // A blocking injected write returns only once the guest pipe accepts
        // the bytes, and the pipe drains through the child and back out via
        // stdout — awaiting it here would deadlock callers that fill stdin
        // before reading stdout. Buffer host-side and pump in the background;
        // failures surface on the next write or on close.
        if (this.#stdin_error !== null) {
          return Promise.reject(this.#stdin_error);
        }
        const data = chunk.slice();
        this.#stdin_tail = this.#stdin_tail
          .then(() => pump(data))
          .catch((error) => {
            this.#stdin_error = error;
          });
        return Promise.resolve();
      },
      close: async () => {
        await this.#stdin_tail;
        await stdin.close();
        if (this.#stdin_error !== null) throw this.#stdin_error;
      },
      abort: () => stdin.close(),
    });
    this.stdout = this.#output_stream(stdout);
    this.stderr = this.#output_stream(stderr);
    this.status = this.#reap(release);
    void this.status.catch(() => {});

    if (signal) {
      const abort = () => {
        this.#aborted = true;
        this.#abort_reason = signal.reason;
        void this.close().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#remove_abort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
    }
  }

  #output_stream(fd: GuestFd): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const data = await read(fd, CHUNK);
          if (data.byteLength === 0) {
            await fd.close();
            controller.close();
          } else {
            controller.enqueue(data);
          }
        } catch (error) {
          controller.error(error);
          await fd.close().catch(() => {});
        }
      },
      cancel: () => fd.close(),
    });
  }

  async #reap(release: () => void): Promise<CommandStatus> {
    try {
      const status = await reap(this.#session, this.pid);
      if (this.#aborted) throw this.#abort_reason;
      const code = WEXITSTATUS(status);
      const signal = WIFSIGNALED(status)
        ? (signal_names.get(WTERMSIG(status)) ?? WTERMSIG(status))
        : null;
      return { success: WIFEXITED(status) && code === 0, code, signal };
    } catch (error) {
      if (this.#aborted) throw this.#abort_reason;
      throw error;
    } finally {
      this.#remove_abort();
      release();
    }
  }

  /**
   * Sends a signal, defaulting to `SIGTERM`. `status` then resolves with
   * the signal set.
   *
   * @example Stop a runaway process
   * ```ts
   * const process = await guest.exec(["sleep", "30"]);
   * await process.kill();
   * console.log(await process.status);
   * // { success: false, code: 0, signal: "SIGTERM" }
   * ```
   */
  async kill(signal: Signal = "SIGTERM") {
    await kill(this.#session, this.pid, signal_numbers[signal]);
  }

  /**
   * Kills the process with `SIGKILL` and waits for it to be reaped.
   * Idempotent, and also called when an `await using` scope ends.
   */
  close(): Promise<void> {
    return (this.#close ??= this.#close_all());
  }

  async #close_all(): Promise<void> {
    this.#remove_abort();
    // Kill before closing the pipe fds: closing an fd does not unblock a
    // read already in flight on it, but the child dying EOFs the pipe. The
    // reap is intentionally NOT cancelled: it must complete to free the
    // agent's process-table slot.
    await kill(this.#session, this.pid, SIG.KILL).catch(() => {});
    const closes = await Promise.allSettled([
      this.#stdin.close(),
      this.#stdout.close(),
      this.#stderr.close(),
    ]);
    const failed = closes.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
