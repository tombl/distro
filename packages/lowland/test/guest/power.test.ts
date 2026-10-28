// Power-off and reboot, end to end: from inside the guest, from the host
// through the agent's power hook, and through the kernel's power button
// with an init that is not the agent.

import assert from "node:assert/strict";
import test from "node:test";
import {
  blockDevice,
  bootConsole,
  bootMachine,
  consoleDevice,
  type Machine,
  serveDevice,
  workerDevice,
} from "../../src/machine/index.ts";
import { machinePlugin, type MachinePlugin } from "../../src/machine/plugin.ts";
import { GuestSession, type Lane } from "../../src/guest/conn.ts";
import { guestAgent, type GuestAgent } from "../../src/guest/index.ts";
import { ext4_root_mount, ext4_rootfs, lifecycle_assets, root_mount } from "./assets.ts";
import { closed_input } from "./helpers.ts";

function text_sink() {
  const output = { text: "" };
  const decoder = new TextDecoder();
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      output.text += decoder.decode(chunk, { stream: true });
    },
  });
  return { output, stream };
}

/** Counts the machine's boots, through the booted hook every boot runs. */
function boot_counter() {
  const counter = {
    boots: 0,
    plugin: {
      configure() {},
      booted() {
        counter.boots += 1;
      },
    } satisfies MachinePlugin,
  };
  return counter;
}

// Plugins after the agent see each boot once the agent is ready.
async function boot_agent(guest: GuestAgent, plugins: MachinePlugin[] = []) {
  return bootMachine({ cpus: 1, plugins: [guest, ...plugins] });
}

async function within<T>(ms: number, promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`not settled in ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 1000 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), what);
}

test("BusyBox commands in the guest power it off", async (t) => {
  for (const command of ["poweroff", "halt"]) {
    await t.test(command, async () => {
      const guest = guestAgent({ mounts: [root_mount()] });
      const machine = await boot_agent(guest);
      // PID 1's shutdown ends this session, so the command may not report.
      await guest.run([command]).catch(() => {});
      assert.deepEqual(await within(20_000, machine.exited), { reason: "poweroff" });
    });
  }
});

test("a reboot in the guest boots it again, and keeps an ext4 root's data", async () => {
  const disk = new Uint8Array(ext4_rootfs);
  const guest = guestAgent({ mounts: [ext4_root_mount(disk)] });
  const counter = boot_counter();
  const machine = await boot_agent(guest, [counter.plugin]);
  try {
    await guest.fs.writeTextFile("/reboot-test", "kept\n");
    await guest.run(["reboot"]).catch(() => {});
    await until(() => counter.boots === 2, "the machine did not boot again");
    // The agent is ready again, over a new session.
    await guest.run(["true"]);
    assert.equal(await guest.fs.readTextFile("/reboot-test"), "kept\n");
    const uptime = Number((await guest.fs.readTextFile("/proc/uptime")).split(" ")[0]);
    assert.ok(uptime < 30, `uptime ${uptime}`);
  } finally {
    assert.deepEqual(await machine.shutdown({ timeoutMs: 20_000 }), { reason: "poweroff" });
  }
});

test("machine.reboot() reboots through the agent", async () => {
  const disk = new Uint8Array(ext4_rootfs);
  const guest = guestAgent({ mounts: [ext4_root_mount(disk)] });
  const counter = boot_counter();
  const machine = await boot_agent(guest, [counter.plugin]);
  try {
    await guest.fs.writeTextFile("/reboot-test", "host\n");
    const { stdout } = await guest.run(["cat", "/proc/sys/kernel/random/boot_id"]);
    await within(30_000, machine.reboot());
    assert.equal(counter.boots, 2);
    assert.equal(await guest.fs.readTextFile("/reboot-test"), "host\n");
    const again = await guest.run(["cat", "/proc/sys/kernel/random/boot_id"]);
    assert.notDeepEqual(again.stdout, stdout);
    // A second reboot works the same way.
    await within(30_000, machine.reboot());
    assert.equal(counter.boots, 3);
    await guest.run(["true"]);
  } finally {
    assert.deepEqual(await machine.shutdown({ timeoutMs: 20_000 }), { reason: "poweroff" });
  }
});

test("machine.shutdown() powers off through the agent and keeps writes", async () => {
  const disk = new Uint8Array(ext4_rootfs);
  const guest = guestAgent({ mounts: [ext4_root_mount(disk)] });
  const machine = await boot_agent(guest);
  await guest.fs.writeTextFile("/shutdown-test", "synced\n");
  // The hook signals PID 1 and nothing presses the kernel's button.
  const plugin = guest[machinePlugin]();
  assert.ok(plugin.power);
  assert.deepEqual(await within(20_000, machine.shutdown()), { reason: "poweroff" });
  // PID 1 unmounted the root, so its journal is clean.
  const superblock = new DataView(disk.buffer, disk.byteOffset + 1024);
  assert.equal(superblock.getUint32(0x60, true) & 0x4, 0);
});

// D-605: PID 1's shutdown can end the hook's session before the kill's reply
// arrives. The hook has started the power-off by then, so it reports true.
test("a power hook whose reply is lost after the signal still succeeds", async () => {
  const guest = guestAgent({ mounts: [root_mount()] });
  const machine = await boot_agent(guest);
  const exchange = GuestSession.prototype.exchange;
  GuestSession.prototype.exchange = function <T>(fn: (lane: Lane) => Promise<T>) {
    return exchange.call(this, (lane) =>
      fn({
        write: (bytes) => lane.write(bytes),
        // The agent has acted on the request and replied. Losing that
        // reply is the race D-605 covers. Failing before the agent has
        // read the request would be a different case, and a racy one.
        read: async (...args: Parameters<Lane["read"]>) => {
          await lane.read(...args);
          throw new Error("injected: the lane dropped with the reply");
        },
      }),
    ) as Promise<T>;
  };
  let answer: boolean;
  try {
    answer = await guest[machinePlugin]().power!("poweroff");
  } finally {
    GuestSession.prototype.exchange = exchange;
  }
  assert.equal(answer, true);
  assert.deepEqual(await within(20_000, machine.exited), { reason: "poweroff" });
});

test("a power hook that cannot send the signal declines", async () => {
  const guest = guestAgent({ mounts: [root_mount()] });
  const machine = await boot_agent(guest);
  const exchange = GuestSession.prototype.exchange;
  GuestSession.prototype.exchange = function () {
    return Promise.reject(new Error("injected: no lane"));
  };
  let answer: boolean;
  try {
    answer = await guest[machinePlugin]().power!("poweroff");
  } finally {
    GuestSession.prototype.exchange = exchange;
  }
  assert.equal(answer, false);
  // The machine still runs, and shuts down through the kernel's button.
  await guest.run(["true"]);
  assert.deepEqual(await within(20_000, machine.shutdown()), { reason: "poweroff" });
});

async function boot_agentless(reboot?: "restart" | "exit", mode = "power") {
  const early = text_sink();
  const console = text_sink();
  const counter = boot_counter();
  const machine = await bootMachine({
    args: [`lifecycle=${mode}`],
    cpus: 1,
    reboot,
    plugins: [
      bootConsole(early.stream),
      lifecycle_assets.boot(),
      lifecycle_assets.root(),
      consoleDevice(closed_input(), console.stream),
      counter.plugin,
    ],
  });
  return { machine, early: early.output, console: console.output, counter };
}

const waiting = (output: { text: string }) =>
  output.text.match(/lifecycle: waiting for power/g)?.length ?? 0;

test("without the agent, the kernel's button powers off and reboots", async () => {
  const { machine, early, console } = await boot_agentless();
  await until(() => waiting(console) === 1, "init did not start");
  await within(30_000, machine.reboot());
  await until(() => waiting(console) === 2, "init did not start again");
  assert.match(console.text, /lifecycle: rebooting/);
  // The boot console carries each boot's early output.
  assert.equal(early.text.match(/Linux version/g)?.length, 2);
  assert.deepEqual(await within(20_000, machine.shutdown()), { reason: "poweroff" });
  assert.match(console.text, /lifecycle: powering off/);
});

test("with reboot: exit, a guest reboot ends the machine", async () => {
  const { machine } = await boot_agentless("exit", "reboot");
  assert.deepEqual(await within(20_000, machine.exited), { reason: "reboot" });
});

test("a guest reboot restarts until it powers off", async () => {
  // lifecycle=reboot reboots on every boot; the host stops it.
  const { machine, counter } = await boot_agentless("restart", "reboot");
  await until(() => counter.boots >= 3, "the machine did not keep rebooting");
  machine.kill();
  assert.deepEqual(await machine.exited, { reason: "kill" });
});

test("a guest that has not powered off by the timeout is killed", async () => {
  const { machine, console } = await boot_agentless(undefined, "power");
  await until(() => waiting(console) === 1, "init did not start");
  const started = performance.now();
  assert.deepEqual(await machine.shutdown({ timeoutMs: 1 }), { reason: "kill" });
  assert.ok(performance.now() - started < 5000);
});

test("a reboot restarts a device served over a port", async () => {
  const channel = new MessageChannel();
  const rootfs = lifecycle_assets.rootfs;
  serveDevice(
    channel.port2,
    blockDevice({
      capacity: rootfs.byteLength,
      read(offset, target) {
        const source = rootfs.subarray(offset, offset + target.byteLength);
        target.set(source);
        return source.byteLength;
      },
    }),
  );
  const root = await workerDevice(channel.port1);
  const console = text_sink();
  let machine: Machine | undefined;
  try {
    machine = await bootMachine({
      args: ["lifecycle=power"],
      cpus: 1,
      plugins: [lifecycle_assets.boot(), root, consoleDevice(closed_input(), console.stream)],
    });
    await until(() => waiting(console.output) === 1, "init did not start");
    await within(30_000, machine.reboot());
    await until(() => waiting(console.output) === 2, "init did not start again");
    assert.deepEqual(await within(20_000, machine.shutdown()), { reason: "poweroff" });
  } finally {
    machine?.kill();
    channel.port1.close();
    channel.port2.close();
  }
});
