// SPDX-License-Identifier: MIT

import { Bytes, FixedArray, Struct, U16BE, U16LE, U8 } from "@lowland/bytes";
import { assert } from "../util.ts";
import { type Device, public_handle, VirtioDevice } from "./device.ts";
import type { Virtqueue, VirtqueueChain } from "./queue.ts";
import { RxQueue } from "./rx.ts";

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
  /** Injects a frame into the switch. */
  send(frame: Uint8Array): Promise<void>;
  /** Removes the port from the switch. */
  close(): void;
}

/** A learning Ethernet switch, created by `ethernetNetwork`. */
export interface EthernetNetwork {
  /** Adds a port; frames addressed to it arrive at `receive`. */
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
        await Promise.all(recipients.map((recipient) => recipient.receive(frame.slice())));
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

class VirtioNic extends VirtioDevice {
  readonly #port: EthernetPort;
  readonly #rx = new RxQueue();
  readonly #pending: Uint8Array[] = [];

  constructor(network: EthernetNetwork, macAddress: MacAddress) {
    super({ id: 1, queues: 2, features: 1n << 5n, config: Uint8Array.from(macAddress) });
    this.#port = network.addPort((frame) => this.#receive(frame));
  }

  #receive(frame: Uint8Array) {
    if (this.stopped) return;
    if (this.#pending.length === MAX_PENDING_FRAMES) this.#pending.shift();
    this.#pending.push(frame.slice());
    this.#flush();
  }

  #flush() {
    while (
      this.#pending.length > 0 &&
      this.#rx.deliver((chain) => write_frame(chain, this.#pending.shift()!))
    );
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
      await this.#port.send(frame.array);
      chain.release(0);
    }
  }

  protected reset() {
    // Frames already accepted for the guest survive; its buffers do not.
    this.#rx.reset();
  }

  protected stop() {
    this.#port.close();
    this.#rx.close();
    this.#pending.length = 0;
  }
}

/**
 * A virtio-net NIC attached to an Ethernet network. NICs on the same
 * network exchange ordinary Ethernet frames without any host TCP/IP
 * involvement.
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
