import { consoleDevice, entropyDevice, type Guest, spawnGuest } from "../src/index.ts";
import { test, type TestContext } from "node:test";
import { assets } from "./assets.ts";
import { closed_input, console_output } from "./helpers.ts";

export interface TestFixture {
  spawn(): Promise<Guest>;
}

export function guest_test(
  name: string,
  fn: (t: TestContext, fixture: TestFixture) => Promise<void>,
) {
  test(name, async (t) => {
    const guests: Guest[] = [];
    const consoles: Promise<void>[] = [];

    async function spawn() {
      const guest = await spawnGuest({
        cpus: 1,
        assets,
        devices: [consoleDevice(closed_input(), console_output()), entropyDevice()],
      });
      guests.push(guest);
      consoles.push(guest.machine.bootConsole.pipeTo(console_output()));
      return guest;
    }

    try {
      await fn(t, {
        spawn,
      });
    } finally {
      for (const guest of guests) guest.machine.close();
      await Promise.all(guests.map((guest) => guest.machine.closed));
      await Promise.all(consoles);
    }
  });
}
