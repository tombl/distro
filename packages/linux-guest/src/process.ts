// ChildProcess: a spawned guest process as a JS object. The agent only
// spawns and reaps; the host makes the pipes and terminals with injected
// syscalls and hands them to the process as posix_spawn file actions, and
// stdio and signals are plain injected syscalls on the host's ends.

import { E, O, SIG, SystemError, WEXITSTATUS, WIFEXITED, WIFSIGNALED, WTERMSIG } from "./abi.ts";
import type { GuestSession } from "./conn.ts";
import { FsFile, with_file_descriptor } from "./file.ts";
import {
  CHUNK,
  type FileAction,
  type GuestFd,
  hang_up,
  kill,
  openat,
  pipe2,
  read,
  reap,
  set_window_size,
  spawn,
  SPAWN,
  terminal_number,
  unlock_terminal,
  write,
} from "./syscalls.ts";

/** A signal that can be sent to a guest process with `ChildProcess.kill`. */
export type Signal =
  | "SIGHUP"
  | "SIGINT"
  | "SIGQUIT"
  | "SIGKILL"
  | "SIGTERM"
  | "SIGUSR1"
  | "SIGUSR2";

/** Bytes of stdin buffered on the host before writes wait for the guest. */
const STDIN_BUFFER = 1024 * 1024;

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

/** The size of a terminal, in character cells. */
export interface TerminalSize {
  readonly rows: number;
  readonly columns: number;
}

/**
 * What one of a process's standard descriptors is connected to, in the
 * `stdio` exec option:
 *
 * - `"pipe"`: a pipe to the host, read or written through the matching
 *   `ChildProcess` stream.
 * - `"null"`: `/dev/null`.
 * - `"stdout"`: for standard error only, whatever standard output is
 *   connected to, like `2>&1` in a shell.
 * - An `FsFile` from `guest.fs.open`: that guest file, sharing its offset.
 */
export type StdioSpec = "pipe" | "null" | "stdout" | FsFile;

/** A process's standard descriptors, as given to spawn_stdio. */
export type Stdio = readonly [StdioSpec, StdioSpec, StdioSpec];

/** A process spawned on stdio: the host's ends of its pipes, where it has
 *  them. */
export interface SpawnedStdio {
  pid: number;
  stdin: GuestFd | null;
  stdout: GuestFd | null;
  stderr: GuestFd | null;
}

/** A process spawned on a terminal. */
export interface SpawnedTerminal {
  pid: number;
  /** The terminal's controlling side; the process has the other side as
   *  its standard input, output, and error. */
  terminal: GuestFd;
}

async function close_all(fds: readonly (GuestFd | null)[]) {
  await Promise.allSettled(fds.map((fd) => fd?.close()));
}

// Like Promise.all, but rejects only once every call has settled, so none is
// still using a descriptor when the caller closes it.
async function all<T extends readonly unknown[]>(
  calls: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  await Promise.allSettled(calls);
  return Promise.all(calls);
}

/** Holds each distinct file open while `use` runs with their descriptors. */
async function with_files<T>(
  files: FsFile[],
  use: (descriptors: Map<FsFile, GuestFd>) => Promise<T>,
  descriptors = new Map<FsFile, GuestFd>(),
): Promise<T> {
  const file = files.find((file) => !descriptors.has(file));
  if (!file) return use(descriptors);
  return with_file_descriptor(file, (fd) => {
    descriptors.set(file, fd);
    return with_files(files, use, descriptors);
  });
}

/**
 * Spawns a process whose standard descriptors are pipes, `/dev/null`, or
 * guest files: the host makes the pipes, the process gets them by file
 * actions, and the host then closes the process's ends.
 */
export async function spawn_stdio(
  session: GuestSession,
  argv: readonly string[],
  cwd: string,
  env: readonly string[],
  stdio: Stdio,
): Promise<SpawnedStdio> {
  const made = await Promise.allSettled(
    stdio.map((spec) => (spec === "pipe" ? pipe2(session, O.CLOEXEC) : null)),
  );
  const pipes = made.map((result) => (result.status === "fulfilled" ? result.value : null));
  // The process reads its stdin pipe and writes the others.
  const ours = pipes.map((pipe, fd) => pipe?.[fd === 0 ? 1 : 0] ?? null);
  const theirs = pipes.map((pipe, fd) => pipe?.[fd === 0 ? 0 : 1] ?? null);
  const failed = made.find((result) => result.status === "rejected");
  if (failed) {
    await close_all([...ours, ...theirs]);
    throw failed.reason;
  }

  const files = stdio.filter((spec) => spec instanceof FsFile);
  try {
    const pid = await with_files(files, (descriptors) => {
      const actions = stdio.map((spec, fd): FileAction => {
        if (spec === "pipe") return { op: "dup2", fd: theirs[fd]!, newfd: fd };
        if (spec === "null") {
          return { op: "open", path: "/dev/null", oflag: fd ? O.WRONLY : O.RDONLY, newfd: fd };
        }
        if (spec === "stdout") return { op: "dup2", fd: 1, newfd: fd };
        const file = descriptors.get(spec)!;
        if (file.session !== session) throw new TypeError("the file is from an earlier session");
        return { op: "dup2", fd: file, newfd: fd };
      });
      return spawn(session, argv, cwd, env, SPAWN.SETSIGDEF, actions);
    });
    return { pid, stdin: ours[0] ?? null, stdout: ours[1] ?? null, stderr: ours[2] ?? null };
  } catch (error) {
    await close_all(ours);
    throw error;
  } finally {
    await close_all(theirs);
  }
}

/**
 * Spawns a process on a new pseudoterminal of the given size. The process
 * leads a new session and opens the terminal as its standard input, which
 * makes it the controlling terminal, then duplicates it onto standard
 * output and error.
 */
export async function spawn_terminal(
  session: GuestSession,
  argv: readonly string[],
  cwd: string,
  env: readonly string[],
  size: TerminalSize,
): Promise<SpawnedTerminal> {
  const terminal = await openat(session, "/dev/ptmx", O.RDWR | O.NOCTTY | O.CLOEXEC, 0);
  try {
    // Sized before the process can ask.
    const [number] = await all([
      terminal_number(terminal),
      unlock_terminal(terminal),
      set_window_size(terminal, size.rows, size.columns),
    ] as const);
    const pid = await spawn(session, argv, cwd, env, SPAWN.SETSID | SPAWN.SETSIGDEF, [
      { op: "open", path: `/dev/pts/${number}`, oflag: O.RDWR, newfd: 0 },
      { op: "dup2", fd: 0, newfd: 1 },
      { op: "dup2", fd: 0, newfd: 2 },
    ]);
    return { pid, terminal };
  } catch (error) {
    await terminal.close().catch(() => {});
    throw error;
  }
}

export type ChildProcessInit = {
  session: GuestSession;
  pid: number;
  signal?: AbortSignal;
  /** Returns the process slot client.ts acquired; called exactly once, when
   *  the reap settles, because until then this process may hold blocked
   *  lanes. */
  release: () => void;
} & (SpawnedStdio | SpawnedTerminal);

const ended = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });

// A stdin that is not a pipe has nothing behind the stream: closing it does
// nothing, not even to a file given as stdin, and writing is a mistake.
const unpiped_input = () =>
  new WritableStream<Uint8Array>({
    write() {
      throw new TypeError("the process's stdin is not a pipe");
    },
  });

/**
 * A guest process spawned by `guest.exec`.
 *
 * `stdin` is a `WritableStream`, `stdout` and `stderr` are
 * `ReadableStream`s, and `status` resolves when the process exits. The
 * process is an async disposable, so `await using` kills it and waits for
 * it to be reaped when the block ends.
 *
 * A process spawned with the `terminal` exec option runs on a guest
 * pseudoterminal instead of pipes. `stdin` is then what the user types and
 * `stdout` is what the terminal displays, with the process's standard error
 * mixed in, so `stderr` is always empty.
 *
 * With the `stdio` exec option, a stream whose descriptor is not `"pipe"`
 * has nothing behind it: `stdout` or `stderr` is empty, and `stdin` rejects
 * writes, while closing it does nothing.
 */
export class ChildProcess implements AsyncDisposable {
  /** Process ID in the guest. */
  readonly pid: number;
  /**
   * A `WritableStream<Uint8Array>` connected to the process's stdin. Close
   * it to send EOF, which is how programs such as `cat` know to finish. A
   * terminal has no end of input, so closing a terminal process's stdin only
   * stops writes. Write `\x04`, the Ctrl-D a user would type, instead. If
   * the process's stdin is not a pipe, writes reject with a `TypeError`, and
   * closing it does nothing: an `FsFile` given as stdin stays open, and the
   * process's input is unchanged.
   *
   * Writes are buffered on the host side, so filling stdin before reading
   * stdout does not deadlock, even once the guest's pipe is full. Once more
   * than 1 MiB is buffered, writes wait for the guest to catch up, so a
   * fast producer cannot exhaust host memory.
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
   * `new Response(process.stdout).text()` collects the whole output.
   * Iterate the stream to handle output as it arrives. Empty if standard
   * output is not a pipe.
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
  /**
   * The process's standard error, as a `ReadableStream<Uint8Array>`. Empty
   * for a terminal process, whose standard error goes to `stdout`, and if
   * standard error is not a pipe.
   */
  readonly stderr: ReadableStream<Uint8Array>;
  /** The process runs on a terminal: it was spawned with `terminal`. */
  readonly terminal: boolean;
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
  readonly #fds: GuestFd[];
  readonly #terminal: GuestFd | null;
  // The terminal fd backs both stdin and stdout, so it shuts down once
  // neither needs it, or when the process is closed. Shutdown is the only
  // path to the fd's close, and no call starts after it begins.
  #terminal_users = 2;
  #terminal_shutdown?: Promise<void>;
  #terminal_pending = 0;
  #terminal_idle?: PromiseWithResolvers<void>;

  #close?: Promise<void>;
  #aborted = false;
  #abort_reason: unknown;
  #remove_abort = () => {};
  #stdin_tail: Promise<void> = Promise.resolve();
  #stdin_buffered = 0;
  #stdin_progress = Promise.withResolvers<void>();
  #stdin_error: unknown = null;
  #stdin_stopped = false;

  constructor(init: ChildProcessInit) {
    const { session, pid, signal, release } = init;
    this.pid = pid;
    this.#session = session;
    this.terminal = "terminal" in init;
    this.#terminal = "terminal" in init ? init.terminal : null;
    this.#fds = (
      "terminal" in init ? [init.terminal] : [init.stdin, init.stdout, init.stderr]
    ).filter((fd) => fd !== null);
    const stdin = "terminal" in init ? init.terminal : init.stdin;
    this.stdin = stdin ? this.#input_stream(stdin) : unpiped_input();
    if ("terminal" in init) {
      this.stdout = this.#terminal_stream(init.terminal);
      this.stderr = ended();
    } else {
      this.stdout = init.stdout ? this.#output_stream(init.stdout) : ended();
      this.stderr = init.stderr ? this.#output_stream(init.stderr) : ended();
    }
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

  #input_stream(stdin: GuestFd): WritableStream<Uint8Array> {
    const pump = async (data: Uint8Array) => {
      let offset = 0;
      while (!this.#stdin_stopped && offset < data.byteLength) {
        const piece = data.subarray(offset, offset + CHUNK);
        const written = await (this.#terminal
          ? this.#terminal_call(() => write(stdin, piece))
          : write(stdin, piece));
        if (written === 0) throw new SystemError(E.IO);
        offset += written;
      }
    };
    return new WritableStream({
      start: (controller) => {
        // A write waiting on backpressure holds off the abort callback until
        // it settles, and it only settles once the guest reads. Close as soon
        // as the stream is aborted so that wait ends.
        controller.signal.addEventListener("abort", () => void this.close().catch(() => {}), {
          once: true,
        });
      },
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
        this.#stdin_buffered += data.byteLength;
        this.#stdin_tail = this.#stdin_tail
          .then(() => {
            if (this.#stdin_error !== null) return;
            return pump(data);
          })
          .catch((error) => {
            this.#stdin_error = error;
          })
          .finally(() => {
            this.#stdin_buffered -= data.byteLength;
            const progress = this.#stdin_progress;
            this.#stdin_progress = Promise.withResolvers();
            progress.resolve();
          });
        return this.#stdin_backpressure();
      },
      // A terminal has no end of input to signal, and closing it would hang
      // up the process. Ending the stream only gives up its use of the fd.
      // Release the terminal before waiting for the pump: if stdout is gone
      // too, shutdown must hang up a write the guest has stopped reading.
      // Input left undelivered then has nowhere to go, so that is no error.
      close: async () => {
        if (this.#terminal) {
          const released = this.#release_terminal();
          await this.#stdin_tail;
          await released;
          if (this.#stdin_error !== null && !this.#terminal_shutdown) throw this.#stdin_error;
          return;
        }
        await this.#stdin_tail;
        await stdin.close();
        if (this.#stdin_error !== null) throw this.#stdin_error;
      },
      // An injected write cannot be cancelled independently. Tear down the
      // process so a blocked write returns before its numeric fd is closed
      // and can be reused.
      abort: () => this.close(),
    });
  }

  // Chunks drain in order, and a failed pump drains the rest without
  // writing, so this always settles.
  async #stdin_backpressure() {
    while (this.#stdin_buffered > STDIN_BUFFER && this.#stdin_error === null) {
      await this.#stdin_progress.promise;
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

  // Reading a terminal fails with EIO once every process has closed its
  // side: that is the terminal's end of file. So does a read after shutdown.
  #terminal_stream(fd: GuestFd): ReadableStream<Uint8Array> {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      return this.#release_terminal();
    };
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const data = await this.#terminal_call(() => read(fd, CHUNK));
          if (data.byteLength === 0) {
            await finish();
            controller.close();
          } else {
            controller.enqueue(data);
          }
        } catch (error) {
          await finish();
          if (error instanceof SystemError && error.code === "EIO") controller.close();
          else controller.error(error);
        }
      },
      cancel: () => finish(),
    });
  }

  // Counts the calls in flight on the terminal fd, so shutdown can wait them
  // out before closing it and none can reach a file that reused its number.
  #terminal_call<T>(call: () => Promise<T>): Promise<T> {
    if (this.#terminal_shutdown) return Promise.reject(new SystemError(E.IO));
    this.#terminal_pending++;
    return call().finally(() => {
      if (--this.#terminal_pending === 0) this.#terminal_idle?.resolve();
    });
  }

  async #release_terminal() {
    if (--this.#terminal_users === 0) await this.#shutdown_terminal();
  }

  // A read or write blocked on the terminal only returns once it hangs up,
  // so hang up before waiting for them. Closing the fd would hang up the
  // terminal anyway.
  #shutdown_terminal(): Promise<void> {
    return (this.#terminal_shutdown ??= (async () => {
      const terminal = this.#terminal!;
      if (this.#terminal_pending > 0) await hang_up(terminal).catch(() => {});
      while (this.#terminal_pending > 0) {
        this.#terminal_idle = Promise.withResolvers();
        await this.#terminal_idle.promise;
      }
      await terminal.close();
    })());
  }

  /**
   * Resizes the process's terminal. The guest kernel sends `SIGWINCH` to
   * the terminal's foreground process group, so full-screen programs
   * redraw. Does nothing once the process is closed.
   *
   * @example Follow the host terminal's size
   * ```ts
   * const shell = await guest.exec(["sh"], {
   *   terminal: { rows: process.stdout.rows, columns: process.stdout.columns },
   * });
   * process.stdout.on("resize", () => {
   *   void shell.resize({ rows: process.stdout.rows, columns: process.stdout.columns });
   * });
   * ```
   */
  async resize(size: TerminalSize): Promise<void> {
    const terminal = this.#terminal;
    if (!terminal) throw new TypeError("resize needs a process spawned with `terminal`");
    if (this.#terminal_shutdown) return;
    await this.#terminal_call(() => set_window_size(terminal, size.rows, size.columns));
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
    this.#stdin_stopped = true;
    // Kill before closing the pipe fds: closing an fd does not unblock a
    // read already in flight on it, but the child dying EOFs the pipe. The
    // reap is intentionally NOT cancelled: it must complete to free the
    // agent's process-table slot.
    await kill(this.#session, this.pid, SIG.KILL).catch(() => {});
    if (this.#terminal) {
      // Other processes on the terminal can keep it open after the leader
      // dies. Shutdown hangs it up, which ends their reads and writes,
      // including the ones this process has in flight.
      await this.#shutdown_terminal();
      await this.#stdin_tail;
      return;
    }
    await this.#stdin_tail;
    const closes = await Promise.allSettled(this.#fds.map((fd) => fd.close()));
    const failed = closes.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
