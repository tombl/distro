import {
  consoleDevice,
  createNetwork,
  entropyDevice,
  type Network,
  type NetworkedGuest,
  spawnGuest,
  type VirtioDevice,
} from "../src/index.ts";
import { resolve4 } from "node:dns/promises";
import { once } from "node:events";
import { createConnection } from "node:net";
import { Duplex } from "node:stream";
import { test, type TestContext } from "node:test";
import { network_test, root_device, user_trap } from "./assets.ts";
import { closed_input, console_output } from "./helpers.ts";

export interface TestFixture {
  network: Network;
  spawn(devices?: readonly VirtioDevice[]): Promise<NetworkedGuest>;
}

export function guest_test(
  name: string,
  fn: (t: TestContext, fixture: TestFixture) => Promise<void>,
) {
  test(name, async (t) => {
    const network = createNetwork({
      async connectTcp(session) {
        const socket = createConnection({
          host: session.target.hostname,
          port: session.target.port,
          signal: session.signal,
        });
        await once(socket, "connect");
        const streams = Duplex.toWeb(socket);
        await Promise.all([
          session.readable.pipeTo(streams.writable as WritableStream<Uint8Array>),
          (streams.readable as ReadableStream<Uint8Array>).pipeTo(session.writable),
        ]);
      },
      resolveDns: resolve4,
    });
    const guests: NetworkedGuest[] = [];
    const consoles: Promise<void>[] = [];

    async function spawn(extra_devices: readonly VirtioDevice[] = []) {
      const guest = await spawnGuest({
        cpus: 1,
        network,
        root: root_device(),
        devices: [
          consoleDevice(closed_input(), console_output()),
          entropyDevice(),
          ...extra_devices,
        ],
      });
      guests.push(guest);
      consoles.push(guest.machine.bootConsole.pipeTo(console_output()));
      await guest.fs.writeFile("/workspace/network-test", network_test);
      await guest.fs.chmod("/workspace/network-test", 0o755);
      await guest.fs.writeFile("/workspace/user-trap", user_trap);
      await guest.fs.chmod("/workspace/user-trap", 0o755);
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
