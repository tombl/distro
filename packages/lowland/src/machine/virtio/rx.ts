// SPDX-License-Identifier: MIT

import type { Virtqueue, VirtqueueChain } from "./queue.ts";

/**
 * Receive buffers the guest has posted, waiting for host data. Host data and
 * guest buffers arrive independently; a kick posts buffers here, and host
 * producers wait on `ready()` until there is somewhere to put their data. That
 * wait is the device's backpressure signal.
 */
export class RxQueue {
  #chains: VirtqueueChain[] = [];
  #waiters: (() => void)[] = [];
  #closed = false;

  /** Takes the chains from a receive-queue kick. */
  post(queue: Virtqueue) {
    if (this.#closed) return;
    for (const chain of queue) this.#chains.push(chain);
    if (this.#chains.length > 0) this.#wake();
  }

  /** The number of posted chains. Zero means the device cannot receive. */
  get available() {
    return this.#chains.length;
  }

  get closed() {
    return this.#closed;
  }

  /** Resolves once a chain is posted, or the queue closes. */
  ready(): Promise<void> {
    if (this.#chains.length > 0 || this.#closed) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /**
   * Fills the next posted chain and releases it with the byte count `fill`
   * returns. Returns false, without calling `fill`, when no chain is posted.
   */
  deliver(fill: (chain: VirtqueueChain) => number): boolean {
    const chain = this.#chains.shift();
    if (!chain) return false;
    chain.release(fill(chain));
    return true;
  }

  /** Drops the posted chains, which belong to the guest's old queue. */
  reset() {
    this.#chains.length = 0;
  }

  /** Drops the posted chains and wakes every waiter, permanently. */
  close() {
    this.#closed = true;
    this.#chains.length = 0;
    this.#wake();
  }

  #wake() {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}
