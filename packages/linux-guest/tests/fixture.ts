import {
  consoleDevice,
  createNetwork,
  entropyDevice,
  type Network,
  type NetworkedGuest,
  spawnGuest,
} from "../src/index.ts";
import { assets, network_test } from "./assets.ts";
import { closed_input, console_output } from "./helpers.ts";

export interface TestFixture {
  network: Network;
  spawn(): Promise<NetworkedGuest>;
}

// @tombl/linux starts fetching and compiling vmlinux.wasm when it is
// imported, so deno's sanitizers see that pre-test work complete mid-test
// and report leaks. Every guest test therefore runs with them disabled.
export function guest_test(
  name: string,
  fn: (t: Deno.TestContext, fixture: TestFixture) => Promise<void>,
) {
  Deno.test({
    name,
    async fn(t) {
      const network = createNetwork({
        connectTcp: (options) => Deno.connect({ ...options, transport: "tcp" }),
        resolveDns: (hostname) => Deno.resolveDns(hostname, "A"),
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
    },
    sanitizeOps: false,
    sanitizeResources: false,
  });
}
