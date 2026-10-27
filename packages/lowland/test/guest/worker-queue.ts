// Firefox starts at most dom.workers.maxPerDomain (512) workers per site and
// queues the rest until one exits, without an error. Model that in Node by
// replacing node:worker_threads' Worker before lowland/machine loads, so a
// test file must import this module first.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Transferable, Worker as NodeWorker, WorkerOptions } from "node:worker_threads";

const worker_threads = createRequire(import.meta.url)("node:worker_threads") as {
  Worker: typeof NodeWorker;
};
const RealWorker = worker_threads.Worker;

/** Live workers, the limit beyond which new ones queue, and how many queued. */
export const worker_queue = { live: 0, limit: Infinity, queued: 0 };

const waiting: (() => void)[] = [];

/** Starts queued workers while there is room under the limit. */
export function drain_worker_queue() {
  while (worker_queue.live < worker_queue.limit && waiting.length > 0) waiting.shift()!();
}

class QueuedWorker extends EventEmitter {
  #worker: NodeWorker | null = null;
  #pending: [unknown, readonly Transferable[] | undefined][] = [];
  #terminated = false;

  constructor(filename: string | URL, options?: WorkerOptions) {
    super();
    const start = () => {
      if (this.#terminated) return drain_worker_queue();
      const worker = new RealWorker(filename, options);
      worker_queue.live++;
      this.#worker = worker;
      for (const type of ["message", "messageerror", "error", "online"]) {
        worker.on(type, (...args: unknown[]) => this.emit(type, ...args));
      }
      worker.on("exit", (code: number) => {
        worker_queue.live--;
        drain_worker_queue();
        this.emit("exit", code);
      });
      for (const [message, transfer] of this.#pending) worker.postMessage(message, transfer);
      this.#pending = [];
    };
    if (worker_queue.live < worker_queue.limit) {
      start();
    } else {
      worker_queue.queued++;
      waiting.push(start);
    }
  }

  postMessage(message: unknown, transfer?: readonly Transferable[]) {
    if (this.#worker) this.#worker.postMessage(message, transfer);
    else this.#pending.push([message, transfer]);
  }

  terminate() {
    this.#terminated = true;
    return this.#worker ? this.#worker.terminate() : Promise.resolve(0);
  }
}

worker_threads.Worker = QueuedWorker as unknown as typeof NodeWorker;
