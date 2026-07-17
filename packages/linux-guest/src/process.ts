import { NR, WEXITSTATUS, WIFEXITED, WIFSIGNALED, WTERMSIG } from "./abi.ts";
import type { GuestConn } from "./conn.ts";
import { SystemError } from "./errors.ts";
import { CHUNK } from "./file.ts";

export type Signal =
  | "SIGHUP"
  | "SIGINT"
  | "SIGQUIT"
  | "SIGKILL"
  | "SIGTERM"
  | "SIGUSR1"
  | "SIGUSR2";

const signals: Record<Signal, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGTERM: 15,
};

export interface CommandStatus {
  readonly success: boolean;
  readonly code: number;
  readonly signal: Signal | number | null;
}

const signalNames = new Map<number, Signal>(
  Object.entries(signals).map(([name, number]) => [number, name as Signal]),
);

export interface ChildProcessInit {
  conn: GuestConn;
  pid: number;
  stdinFd: number;
  stdoutFd: number;
  stderrFd: number;
  signal?: AbortSignal;
}

export class ChildProcess implements AsyncDisposable {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<CommandStatus>;

  readonly #conn: GuestConn;
  readonly #stdinFd: number;
  readonly #stdoutFd: number;
  readonly #stderrFd: number;

  #closed = false;
  #aborted = false;
  #abortReason: unknown;
  #removeAbort = () => {};
  #closedFds = new Set<number>();
  #stdinTail: Promise<void> = Promise.resolve();
  #stdinError: unknown = null;

  constructor(init: ChildProcessInit) {
    const { conn, pid, stdinFd, stdoutFd, stderrFd, signal } = init;
    this.pid = pid;
    this.#conn = conn;
    this.#stdinFd = stdinFd;
    this.#stdoutFd = stdoutFd;
    this.#stderrFd = stderrFd;

    const pump = async (data: Uint8Array) => {
      let offset = 0;
      while (offset < data.byteLength) {
        const slice = data.subarray(offset, offset + CHUNK);
        const result = await conn.blocking(() =>
          conn.syscall(NR.write, stdinFd, { in: slice }, slice.byteLength),
        );
        if (result.ret === -1n) {
          throw new SystemError(result.errno, "write");
        }
        const written = Number(result.ret);
        if (written === 0) throw new SystemError(5, "write"); // EIO
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
        if (this.#stdinError !== null) {
          return Promise.reject(this.#stdinError as Error);
        }
        const data = chunk.slice();
        this.#stdinTail = this.#stdinTail
          .then(() => pump(data))
          .catch((error: unknown) => {
            this.#stdinError = error;
          });
        return Promise.resolve();
      },
      close: async () => {
        await this.#stdinTail;
        await this.#closeFd(stdinFd);
        if (this.#stdinError !== null) throw this.#stdinError as Error;
      },
      abort: () => this.#closeFd(stdinFd),
    });
    this.stdout = this.#outputStream(stdoutFd, "stdout");
    this.stderr = this.#outputStream(stderrFd, "stderr");
    this.status = this.#reap();
    void this.status.catch(() => {});

    if (signal) {
      const abort = () => {
        this.#aborted = true;
        this.#abortReason = signal.reason;
        this.close();
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#removeAbort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
    }
  }

  // Closes each guest fd at most once, no matter how many paths race to it
  // (stream EOF, cancel, and close() all try): a second injected close could
  // hit an unrelated file that reused the fd number in the meantime.
  #closeFd(fd: number): Promise<void> {
    if (this.#closedFds.has(fd)) return Promise.resolve();
    this.#closedFds.add(fd);
    return this.#conn.syscall(NR.close, fd).then(
      () => {},
      () => {},
    );
  }

  #outputStream(fd: number, name: string): ReadableStream<Uint8Array> {
    const conn = this.#conn;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const result = await conn.blocking(() =>
            conn.syscall(NR.read, fd, { out: CHUNK, retSized: true }, CHUNK),
          );
          if (result.ret === -1n) throw new SystemError(result.errno, name);
          if (result.ret === 0n) {
            controller.close();
            await this.#closeFd(fd);
          } else {
            controller.enqueue(result.out[0]!);
          }
        } catch (error) {
          controller.error(error);
          await this.#closeFd(fd);
        }
      },
      cancel: () => {
        void this.#closeFd(fd);
      },
    });
  }

  async #reap(): Promise<CommandStatus> {
    try {
      const result = await this.#conn.blocking(() => this.#conn.reap(this.pid));
      if (this.#aborted) throw this.#abortReason;
      if (result.ret === -1n) throw new SystemError(result.errno, "waitpid");
      const status = result.status;
      const code = WEXITSTATUS(status);
      const signal = WIFSIGNALED(status)
        ? (signalNames.get(WTERMSIG(status)) ?? WTERMSIG(status))
        : null;
      return { success: WIFEXITED(status) && code === 0, code, signal };
    } catch (error) {
      if (this.#aborted) throw this.#abortReason;
      throw error;
    } finally {
      this.#removeAbort();
    }
  }

  async kill(signal: Signal = "SIGTERM") {
    await this.#conn.syscall(NR.kill, this.pid, signals[signal]);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeAbort();
    // Best-effort teardown. The reap is intentionally NOT cancelled: it must
    // complete to free the agent's process-table slot.
    void this.#conn.syscall(NR.kill, this.pid, signals.SIGKILL).catch(() => {});
    void this.#closeFd(this.#stdinFd);
    void this.#closeFd(this.#stdoutFd);
    void this.#closeFd(this.#stderrFd);
  }

  async [Symbol.asyncDispose]() {
    this.close();
  }
}
