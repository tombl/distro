import {
  bootMachine,
  consoleDevice,
  entropyDevice,
  type Machine,
  type Device,
} from "@lowland/kernel";
import {
  createNetwork,
  guestAgent,
  type GuestAgent,
  type Network,
  type NetworkAttachment,
} from "../src/index.ts";
import { resolve4 } from "node:dns/promises";
import { once } from "node:events";
import { createConnection } from "node:net";
import { Duplex } from "node:stream";
import { test, type TestContext } from "node:test";
import { network_test, root_mount, user_trap } from "./assets.ts";
import { closed_input, console_output } from "./helpers.ts";

/** One `connectTcp` invocation, observed from the host. */
export interface OutboundSession {
  readonly target: { readonly hostname: string; readonly port: number };
  readonly signal: AbortSignal;
  /** How each direction's `pipeTo` ended: guest to host, then host to guest. */
  readonly pipes: Promise<PromiseSettledResult<void>[]>;
}

export interface TestFixture {
  network: Network;
  /** Every outbound TCP session the guests have opened, in order. */
  outbound: OutboundSession[];
  /**
   * Target ports whose `connectTcp` keeps running after both pipes settle,
   * until the session's signal aborts, like a host socket still flushing.
   */
  lingering: Set<number>;
  spawn(devices?: readonly Device[]): Promise<TestGuest>;
}

export interface TestGuest extends GuestAgent {
  readonly machine: Machine;
  readonly network: NetworkAttachment;
}

export function guest_test(
  name: string,
  fn: (t: TestContext, fixture: TestFixture) => Promise<void>,
) {
  test(name, async (t) => {
    const outbound: OutboundSession[] = [];
    const lingering = new Set<number>();
    const network = createNetwork({
      async connectTcp(session) {
        const pipes = Promise.withResolvers<PromiseSettledResult<void>[]>();
        outbound.push({ target: session.target, signal: session.signal, pipes: pipes.promise });
        // The `createNetwork` JSDoc recipe, verbatim apart from recording
        // how each pipe settled.
        const socket = createConnection({
          host: session.target.hostname,
          port: session.target.port,
          signal: session.signal,
          allowHalfOpen: true,
        });
        void pipes.promise.catch(() => {});
        await once(socket, "connect").catch((error) => {
          pipes.reject(error);
          throw error;
        });
        const streams = Duplex.toWeb(socket);
        const piped = [
          session.readable.pipeTo(streams.writable as WritableStream<Uint8Array>),
          (streams.readable as ReadableStream<Uint8Array>).pipeTo(session.writable),
        ];
        pipes.resolve(Promise.allSettled(piped));
        await Promise.all(piped);
        if (lingering.has(session.target.port) && !session.signal.aborted)
          await once(session.signal, "abort");
      },
      resolveDns: resolve4,
    });
    const guests: TestGuest[] = [];
    async function spawn(extra_devices: readonly Device[] = []) {
      const agent = guestAgent({ mounts: [root_mount()] });
      const attachment = network.attach(agent);
      const machine = await bootMachine({
        cpus: 1,
        // Put an agent-dependent plugin before the agent deliberately:
        // readiness does not depend on plugin array order.
        plugins: [
          attachment,
          agent,
          consoleDevice(closed_input(), console_output()),
          entropyDevice(),
          ...extra_devices,
        ],
      });
      const guest: TestGuest = Object.assign(agent, { machine, network: attachment });
      guests.push(guest);
      await guest.fs.writeFile("/tmp/network-test", network_test);
      await guest.fs.chmod("/tmp/network-test", 0o755);
      await guest.fs.writeFile("/tmp/user-trap", user_trap);
      await guest.fs.chmod("/tmp/user-trap", 0o755);
      return guest;
    }

    try {
      await fn(t, {
        network,
        outbound,
        lingering,
        spawn,
      });
    } finally {
      network.close();
      for (const guest of guests) guest.machine.close();
      await Promise.all(guests.map((guest) => guest.machine.closed));
    }
  });
}
