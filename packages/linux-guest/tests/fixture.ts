import {
  consoleDevice,
  createNetwork,
  entropyDevice,
  type Network,
  type NetworkedGuest,
  spawnGuest,
} from "../src/index.ts";
import { resolve4 } from "node:dns/promises";
import { once } from "node:events";
import { createConnection } from "node:net";
import { Duplex } from "node:stream";
import { test, type TestContext } from "node:test";
import { assets, network_test } from "./assets.ts";
import { closed_input, console_output } from "./helpers.ts";

export interface TestFixture {
  network: Network;
  spawn(): Promise<NetworkedGuest>;
}

export function guest_test(
  name: string,
  fn: (t: TestContext, fixture: TestFixture) => Promise<void>,
) {
  test(name, async (t) => {
    const network = createNetwork({
      async connectTcp({ hostname, port }) {
        const socket = createConnection({ host: hostname, port });
        await once(socket, "connect");
        const streams = Duplex.toWeb(socket);
        return {
          readable: streams.readable as ReadableStream<Uint8Array>,
          writable: streams.writable as WritableStream<Uint8Array>,
          close: () => socket.destroy(),
        };
      },
      resolveDns: resolve4,
    });
    const guests: NetworkedGuest[] = [];
    const consoles: Promise<void>[] = [];

    async function spawn() {
      const guest = await spawnGuest({
        cpus: 2,
        memoryMib: 192,
        network,
        assets,
        devices: [consoleDevice(closed_input(), console_output()), entropyDevice()],
      });
      guests.push(guest);
      consoles.push(guest.machine.bootConsole.pipeTo(console_output()));
      await guest.fs.writeFile("/workspace/network-test", network_test);
      await guest.fs.chmod("/workspace/network-test", 0o755);
      return guest;
    }

    try {
      await fn(t, {
        network,
        spawn,
      });
    } finally {
      network.close();
      for (const guest of guests) guest.machine.close();
      await Promise.all(guests.map((guest) => guest.machine.closed));
      await Promise.all(consoles);
    }
  });
}
