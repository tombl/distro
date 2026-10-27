// SPDX-License-Identifier: MIT

import { Bytes, FixedArray, Struct, U16BE, U16LE, U8 } from "@lowland/bytes";
import { assert } from "../util.ts";
import { type Device, public_handle, VirtioDevice } from "./device.ts";
import type { Virtqueue, VirtqueueChain } from "./queue.ts";
import { RxQueue } from "./rx.ts";

// Frames for the guest beyond this backlog make `receive` wait until they are
// delivered, which throttles a sender that awaits it.
const RECEIVE_BACKLOG = 16;
// Senders that do not wait, such as broadcast floods, are cut off here.
const MAX_PENDING_FRAMES = 256;

// Modern virtio-net always uses virtio_net_hdr_mrg_rxbuf, even when the
// mergeable-buffer feature itself is not offered.
class VirtioNetHeader extends Struct({
  flags: U8,
  gso_type: U8,
  header_length: U16LE,
  gso_size: U16LE,
  checksum_start: U16LE,
  checksum_offset: U16LE,
  buffer_count: U16LE,
}) {}

const Mac = FixedArray(U8, 6);

class EthernetHeader extends Struct({
  destination: Mac,
  source: Mac,
  type: U16BE,
}) {}

/** A MAC address as six bytes. */
export type MacAddress = readonly [number, number, number, number, number, number];

/**
 * One port on an Ethernet switch. Frames addressed to the port arrive at
 * the handler given to `addPort`.
 */
export interface EthernetPort {
  /**
   * Injects a frame into the switch. A frame for one known recipient settles
   * once that recipient's handler accepts it, so awaiting `send` applies the
   * recipient's backpressure. Flooded frames do not wait.
   */
  send(frame: Uint8Array): Promise<void>;
  /** Removes the port from the switch. */
  close(): void;
}

/** A learning Ethernet switch, created by `ethernetNetwork`. */
export interface EthernetNetwork {
  /**
   * Adds a port. Frames addressed to it arrive at `receive`, which may return
   * a promise to hold back unicast senders until it can take more.
   */
  addPort(receive: (frame: Uint8Array) => void | PromiseLike<void>): EthernetPort;
  /** Closes every port. */
  close(): void;
}

interface SwitchPort {
  receive(frame: Uint8Array): void | PromiseLike<void>;
  closed: boolean;
}

function mac_key(address: readonly number[]) {
  return Array.from(address, (byte) => byte.toString(16).padStart(2, "0")).join(":");
}

function is_multicast(address: readonly number[]) {
  return (address[0]! & 1) !== 0;
}

/** A small learning Ethernet switch. Unknown and multicast frames are flooded. */
export function ethernetNetwork(): EthernetNetwork {
  const ports = new Set<SwitchPort>();
  const learned = new Map<string, SwitchPort>();
  let closed = false;

  function addPort(receive: (frame: Uint8Array) => void | PromiseLike<void>): EthernetPort {
    assert(!closed, "cannot add a port to a closed Ethernet network");
    const port: SwitchPort = { receive, closed: false };
    ports.add(port);

    return {
      async send(frame) {
        if (closed) return;
        assert(!port.closed, "cannot send from a closed Ethernet port");
        assert(
          frame.byteLength >= EthernetHeader.size,
          "Ethernet frame is shorter than its header",
        );
        const header = new EthernetHeader(frame);
        learned.set(mac_key(header.source), port);

        const destination = learned.get(mac_key(header.destination));
        const recipients =
          destination && !is_multicast(header.destination)
            ? destination === port || destination.closed
              ? []
              : [destination]
            : Array.from(ports, (candidate) =>
                candidate !== port && !candidate.closed ? candidate : undefined,
              ).filter((candidate): candidate is SwitchPort => !!candidate);
        if (destination && recipients.length === 1) {
          await recipients[0]!.receive(frame.slice());
          return;
        }
        // One stalled port must not hold up a flood to the others.
        for (const recipient of recipients) {
          void Promise.resolve(recipient.receive(frame.slice())).catch(() => {});
        }
      },
      close() {
        if (port.closed) return;
        port.closed = true;
        ports.delete(port);
        for (const [mac, owner] of learned) {
          if (owner === port) learned.delete(mac);
        }
      },
    };
  }

  return {
    addPort,
    close() {
      if (closed) return;
      closed = true;
      for (const port of ports) port.closed = true;
      ports.clear();
      learned.clear();
    },
  };
}

/** A virtio-net NIC attached to an Ethernet network. */
export interface EthernetDevice extends Device {
  /** The NIC's MAC address. */
  readonly macAddress: MacAddress;
}

/** Configuration for a virtio-net NIC. */
export interface EthernetDeviceOptions {
  /** Defaults to a random locally-administered address. */
  macAddress?: MacAddress;
}

function random_mac(): MacAddress {
  const address = crypto.getRandomValues(new Uint8Array(6));
  address[0] = (address[0]! | 0x02) & 0xfe;
  return Array.from(address) as unknown as MacAddress;
}

function write_frame(chain: VirtqueueChain, frame: Uint8Array) {
  const packet = new Bytes(VirtioNetHeader.size + frame.byteLength);
  packet.alloc(VirtioNetHeader).value = {
    flags: 0,
    gso_type: 0,
    header_length: 0,
    gso_size: 0,
    checksum_start: 0,
    checksum_offset: 0,
    buffer_count: 1,
  };
  packet.append(frame);
  const bytes = packet.array;
  let offset = 0;
  for (const descriptor of chain) {
    assert(descriptor.writable, "virtio-net receive descriptor must be writable");
    const length = Math.min(bytes.byteLength - offset, descriptor.array.byteLength);
    if (length > 0) descriptor.array.set(bytes.subarray(offset, offset + length));
    offset += length;
  }
  assert(offset === bytes.byteLength, "virtio-net receive buffer is too small");
  return offset;
}

interface PendingFrame {
  frame: Uint8Array;
  delivered?: PromiseWithResolvers<void>;
}

class VirtioNic extends VirtioDevice {
  readonly #port: EthernetPort;
  readonly #rx = new RxQueue();
  readonly #pending: PendingFrame[] = [];
  /**
   * Transmits waiting on a recipient, released when the guest's transmit
   * queue goes away so a stalled recipient cannot hold it. The recipient
   * keeps the frame.
   */
  readonly #waiting = new Set<() => void>();

  constructor(network: EthernetNetwork, macAddress: MacAddress) {
    super({ id: 1, queues: 2, features: 1n << 5n, config: Uint8Array.from(macAddress) });
    this.#port = network.addPort((frame) => this.#receive(frame));
  }

  #receive(frame: Uint8Array): void | Promise<void> {
    if (this.stopped || this.#pending.length >= MAX_PENDING_FRAMES) return;
    const pending: PendingFrame = { frame: frame.slice() };
    this.#pending.push(pending);
    this.#flush();
    if (this.#pending.length <= RECEIVE_BACKLOG) return;
    pending.delivered = Promise.withResolvers();
    return pending.delivered.promise;
  }

  #flush() {
    while (
      this.#pending.length > 0 &&
      this.#rx.deliver((chain) => write_frame(chain, this.#pending[0]!.frame))
    ) {
      this.#pending.shift()!.delivered?.resolve();
    }
  }

  protected kick(vq: number, queue: Virtqueue) {
    if (vq === 0) {
      this.#rx.post(queue);
      this.#flush();
      return;
    }
    return this.#transmit(queue);
  }

  async #transmit(queue: Virtqueue) {
    for (const chain of queue) {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (const descriptor of chain) {
        assert(!descriptor.writable, "virtio-net transmit descriptor must be readable");
        chunks.push(descriptor.array);
        length += descriptor.array.byteLength;
      }
      assert(length >= VirtioNetHeader.size, "short virtio-net transmit header");
      const frame = new Bytes(length - VirtioNetHeader.size);
      let source_offset = VirtioNetHeader.size;
      for (const chunk of chunks) {
        if (source_offset >= chunk.byteLength) {
          source_offset -= chunk.byteLength;
          continue;
        }
        frame.append(chunk.subarray(source_offset));
        source_offset = 0;
      }
      assert(frame.length === frame.capacity, "short virtio-net transmit frame");
      // Holding the chain until the network accepts the frame throttles the guest.
      let abandon!: () => void;
      const abandoned = new Promise<boolean>((resolve) => (abandon = () => resolve(true)));
      this.#waiting.add(abandon);
      try {
        if (await Promise.race([this.#port.send(frame.array).then(() => false), abandoned])) return;
      } finally {
        this.#waiting.delete(abandon);
      }
      chain.release(0);
    }
  }

  protected reset() {
    // Frames already accepted for the guest survive; its buffers do not.
    this.#rx.reset();
    this.#abandon_transmits();
  }

  #abandon_transmits() {
    for (const abandon of this.#waiting) abandon();
    this.#waiting.clear();
  }

  protected stop() {
    this.#abandon_transmits();
    this.#port.close();
    this.#rx.close();
    for (const { delivered } of this.#pending.splice(0)) delivered?.resolve();
  }
}

/**
 * A virtio-net NIC attached to an Ethernet network. NICs on the same
 * network exchange ordinary Ethernet frames without any host TCP/IP
 * involvement. Frames for the guest are held until it posts receive buffers;
 * past a small backlog, the NIC's port handler returns a promise, so unicast
 * senders that await `EthernetPort.send` are throttled to the guest's pace.
 */
export function ethernetDevice(
  network: EthernetNetwork,
  { macAddress = random_mac() }: EthernetDeviceOptions = {},
): EthernetDevice {
  assert(
    macAddress.length === 6 &&
      macAddress.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
    "invalid MAC address",
  );
  return public_handle(new VirtioNic(network, macAddress), { macAddress });
}
