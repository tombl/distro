// SPDX-License-Identifier: MIT

import { Struct, U16LE } from "@lowland/bytes";
import { assert } from "../util.ts";
import { type Device, public_handle, VirtioDevice } from "./device.ts";
import type { Virtqueue } from "./queue.ts";
import { RxQueue } from "./rx.ts";

const Features = {
  SIZE: 1n << 0n,
} as const;

class ConsoleConfig extends Struct({
  columns: U16LE,
  rows: U16LE,
}) {}

/** A console device whose dimensions can be changed after boot. */
export interface ConsoleDevice extends Device {
  /**
   * Changes the console's dimensions. The console boots at 80×24. The guest
   * sees the new size and delivers `SIGWINCH` to the foreground process.
   */
  resize(columns: number, rows: number): void;
}

class VirtioConsole extends VirtioDevice {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  readonly #size: ConsoleConfig;
  readonly #rx = new RxQueue();
  // Linux exposes the legacy console receive queue before hvc0 is ready to
  // consume it. Its first transmit kick proves that the console handoff has
  // completed. Until then, input stays in the host stream.
  #opened = Promise.withResolvers<void>();
  #guest_ready = false;
  #reader_cancellation: Promise<void> | undefined;
  #writer_abortion: Promise<void> | undefined;

  constructor(input: ReadableStream<Uint8Array> | null, output: WritableStream<Uint8Array> | null) {
    const config = new Uint8Array(ConsoleConfig.size);
    super({ id: 3, queues: 2, features: Features.SIZE, config });
    this.#size = new ConsoleConfig(config);
    this.#size.columns = 80;
    this.#size.rows = 24;
    this.#reader = input?.getReader();
    this.#writer = output?.getWriter();
    if (this.#reader) this.#pump(this.#reader).catch(console.error);
  }

  async #receivable() {
    while (!this.stopped && !(this.#guest_ready && this.#rx.available > 0)) {
      await (this.#guest_ready ? this.#rx.ready() : this.#opened.promise);
    }
    return !this.stopped;
  }

  // Input is read from the host stream only when the guest has a buffer for
  // it, so a fast producer is throttled by the guest. At most one chunk is
  // held here, and it survives the reset Linux performs while probing.
  async #pump(reader: ReadableStreamDefaultReader<Uint8Array>) {
    let chunk: Uint8Array | undefined;
    while (await this.#receivable()) {
      if (!chunk) {
        const { value, done } = await reader.read();
        if (done) return;
        if (value.byteLength > 0) chunk = value;
        continue;
      }
      const pending = chunk;
      let n = 0;
      this.#rx.deliver((chain) => {
        const [desc, trailing] = chain;
        assert(desc && desc.writable, "receiver must be writable");
        assert(!trailing, "too many descriptors");
        n = Math.min(pending.byteLength, desc.array.byteLength);
        desc.array.set(pending.subarray(0, n));
        return n;
      });
      chunk = n < pending.byteLength ? pending.subarray(n) : undefined;
    }
  }

  protected kick(vq: number, queue: Virtqueue) {
    if (vq === 0) {
      if (this.#reader) this.#rx.post(queue);
      return;
    }
    return this.#transmit(queue);
  }

  async #transmit(queue: Virtqueue) {
    if (!this.#guest_ready) {
      this.#guest_ready = true;
      this.#opened.resolve();
    }
    for (const chain of queue) {
      let n = 0;
      for (const { array, writable } of chain) {
        assert(!writable, "transmitter must be readable");
        await this.#writer?.write(array);
        n += array.byteLength;
      }
      chain.release(n);
    }
  }

  protected reset() {
    // Receive descriptors belong to the old queue, but host input belongs to
    // the console and must survive the reset.
    this.#rx.reset();
    this.#guest_ready = false;
    // Wake the pump so it waits on the replacement.
    this.#opened.resolve();
    this.#opened = Promise.withResolvers();
  }

  protected stop() {
    this.#rx.close();
    this.#opened.resolve();
    this.#reader_cancellation ??= this.#reader?.cancel();
    this.#writer_abortion ??= this.#writer?.abort();
  }

  protected async close() {
    const results = await Promise.allSettled([this.#reader_cancellation, this.#writer_abortion]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  resize(columns: number, rows: number) {
    assert(
      Number.isInteger(columns) && columns > 0 && columns <= 0xffff,
      "console columns must be a positive 16-bit integer",
    );
    assert(
      Number.isInteger(rows) && rows > 0 && rows <= 0xffff,
      "console rows must be a positive 16-bit integer",
    );
    if (this.#size.columns === columns && this.#size.rows === rows) return;
    this.#size.columns = columns;
    this.#size.rows = rows;
    this.update_config();
  }
}

/**
 * A virtio console: a byte pipe to a tty, visible in the guest as
 * `/dev/hvc0`.
 *
 * `input` is a `ReadableStream` of bytes sent to the tty, as from a keyboard.
 * It is read only as fast as the guest consumes it. `output` is a
 * `WritableStream` of bytes from the tty for a terminal to render. Either may
 * be `null`: `consoleDevice(null, output)` is a read-only console, such as a
 * boot log.
 */
export function consoleDevice(
  input: ReadableStream<Uint8Array> | null,
  output: WritableStream<Uint8Array> | null,
): ConsoleDevice {
  const device = new VirtioConsole(input, output);
  return public_handle(device, {
    resize: (columns: number, rows: number) => device.resize(columns, rows),
  });
}
