import type { VsockConnection } from "@tombl/linux";
import {
  maxFramePayload,
  MessageType,
  readFrame,
  readU32,
  throwIfError,
  u32,
  writeFrame,
} from "./protocol.ts";
import { ProtocolError } from "./errors.ts";

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

function outputStream(connection: VsockConnection, syscall: string) {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const frame = await readFrame(connection);
        throwIfError(frame, syscall);
        if (frame.type === MessageType.End) {
          controller.close();
          connection.close();
        } else if (frame.type === MessageType.Data) {
          controller.enqueue(frame.payload);
        } else {
          throw new ProtocolError(`invalid ${syscall} frame`);
        }
      } catch (error) {
        controller.error(error);
        connection.close();
      }
    },
    cancel() {
      connection.close();
    },
  });
}

export class ChildProcess implements AsyncDisposable {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<CommandStatus>;

  #closed = false;
  #aborted = false;
  #abortReason: unknown;
  #removeAbort = () => {};

  constructor(
    readonly pid: number,
    private readonly control: VsockConnection,
    private readonly input: VsockConnection,
    private readonly output: VsockConnection,
    private readonly error: VsockConnection,
    signal?: AbortSignal,
  ) {
    this.stdin = new WritableStream({
      async write(chunk) {
        for (
          let offset = 0;
          offset < chunk.byteLength;
          offset += maxFramePayload
        ) {
          await writeFrame(
            input,
            MessageType.Data,
            chunk.subarray(offset, offset + maxFramePayload),
          );
        }
      },
      async close() {
        await writeFrame(input, MessageType.End);
        input.close();
      },
      abort() {
        input.close();
      },
    });
    this.stdout = outputStream(output, "stdout");
    this.stderr = outputStream(error, "stderr");
    this.status = this.#readStatus();
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

  async #readStatus(): Promise<CommandStatus> {
    try {
      const frame = await readFrame(this.control);
      throwIfError(frame, "waitpid");
      if (frame.type !== MessageType.Status || frame.payload.byteLength !== 8) {
        throw new ProtocolError("invalid process status");
      }
      const code = readU32(frame.payload);
      const signalNumber = readU32(frame.payload, 4);
      return {
        success: signalNumber === 0 && code === 0,
        code,
        signal: signalNumber === 0
          ? null
          : (signalNames.get(signalNumber) ?? signalNumber),
      };
    } catch (error) {
      if (this.#aborted) throw this.#abortReason;
      throw error;
    } finally {
      this.#removeAbort();
      this.control.close();
    }
  }

  kill(signal: Signal = "SIGTERM") {
    return writeFrame(this.control, MessageType.Signal, u32(signals[signal]));
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeAbort();
    this.control.close();
    this.input.close();
    this.output.close();
    this.error.close();
  }

  async [Symbol.asyncDispose]() {
    this.close();
  }
}
