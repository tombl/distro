// PROTOTYPE (redesign phase 0 spike), risks (h), (i) and (j).
//   node spike/power.ts <scenario>
// guest-poweroff | guest-halt | guest-reboot   BusyBox commands signal PID 1
// host-shutdown                                machine.shutdown() via the agent's power hook
// host-button                                  machine.shutdown() via the kernel power button
// lane-killall                                 (h) kill(-1) etc. issued from a lane
// reboot-restart                               (i) reboot: "restart" with the same devices
import {
  blockDevice,
  bootConsole,
  bootMachine,
  consoleDevice,
  type Machine,
} from "@lowland/kernel";
import { mount, raw_syscall, reap, spawn, umount2 } from "../src/syscalls.ts";
import { ext4_rootfs, rootfs } from "../tests/assets.ts";
import { closed_input } from "../tests/helpers.ts";
import { MS, NR, RB, readText, SIG, spikeGuest, type SpikeMount } from "./lib.ts";

const scenario = process.argv[2] ?? "guest-poweroff";
const decoder = new TextDecoder();
const t0 = performance.now();
const at = () => `${(performance.now() - t0).toFixed(0)}ms`;
let log = "";
const sink = () =>
  new WritableStream<Uint8Array>({
    write(chunk) {
      log += decoder.decode(Uint8Array.from(chunk));
    },
  });

const disk = (bytes: Uint8Array, serial: string, writable: boolean) =>
  blockDevice(
    {
      capacity: bytes.byteLength,
      read(offset, target) {
        const source = bytes.subarray(offset, offset + target.byteLength);
        target.set(source);
        return source.byteLength;
      },
      ...(writable
        ? {
            write(offset: number, data: Uint8Array) {
              bytes.set(data, offset);
              return data.byteLength;
            },
            flush() {},
          }
        : {}),
    },
    { serial },
  );

const data = new Uint8Array(ext4_rootfs); // an ext4 image used as a data disk

async function boot(options: {
  reboot?: "restart" | "exit";
  data_mode?: "rw" | "ro";
  power_hook?: boolean;
}) {
  const mounts: SpikeMount[] = [
    { path: "/", serial: "m0", type: "erofs", mode: "overlay" },
    { path: "/run", type: "tmpfs", mode: "rw" },
    { path: "/tmp", type: "tmpfs", mode: "rw" },
    { path: "/data", serial: "m1", type: "ext4", mode: options.data_mode ?? "rw" },
  ];
  const guest = spikeGuest(mounts);
  if (options.power_hook === false) delete guest.plugin.power;
  const machine = await bootMachine({
    cpus: 2,
    reboot: options.reboot ?? "exit",
    plugins: [
      bootConsole(sink()),
      guest.plugin,
      disk(rootfs, "m0", false),
      disk(data, "m1", (options.data_mode ?? "rw") === "rw"),
      consoleDevice(closed_input(), sink()),
    ],
  });
  return { machine, guest };
}

const agent_lines = () =>
  log
    .split("\n")
    .filter((line) =>
      /linux-guest-agent|reboot|poweroff|restart|EXT4-fs|Power down|session killed/i.test(line),
    )
    .map((line) => `  ${line}`)
    .join("\n");

async function report(machine: Machine) {
  const exit = await machine.exited;
  console.log(
    `exited @${at()}: ${JSON.stringify(exit, (_k, v) => (v instanceof Error ? v.message : v))}`,
  );
  console.log("console:\n" + agent_lines());
}

/** A second machine mounts the data disk read-only: a dirty journal fails. */
async function check_clean() {
  log = "";
  const { machine, guest } = await boot({ data_mode: "ro" });
  console.log(
    "read-only remount of the data disk:",
    JSON.stringify((await guest.sh("grep /data /proc/mounts; cat /data/note")).output),
  );
  machine.kill();
  await machine.exited;
}

switch (scenario) {
  case "guest-poweroff":
  case "guest-halt":
  case "guest-reboot": {
    const { machine, guest } = await boot({ reboot: "exit" });
    const command = scenario.slice("guest-".length);
    console.log(`booted @${at()}; writing /data/note, then running ${command}`);
    void guest.sh(`echo note-from-${command} > /data/note; sleep 100 & ${command}`).catch(() => {});
    await report(machine);
    await check_clean();
    break;
  }
  case "host-shutdown":
  case "host-button": {
    const { machine, guest } = await boot({ power_hook: scenario === "host-shutdown" });
    console.log(`booted @${at()}`);
    console.log(
      JSON.stringify(
        (await guest.sh("echo note-from-shutdown > /data/note; sleep 1000 >/dev/null 2>&1 &"))
          .output,
      ),
    );
    console.log(
      `shutdown() -> ${JSON.stringify(await machine.shutdown({ timeoutMs: 15_000 }))} @${at()}`,
    );
    console.log("console:\n" + agent_lines());
    await check_clean();
    break;
  }
  case "lane-killall": {
    const { machine, guest } = await boot({});
    const session = await guest.client.session();
    const env = ["PATH=/bin:/usr/bin:/sbin:/usr/sbin"];
    const sleeper = await spawn(session, ["sleep", "1000"], "/", env);
    const shell = await spawn(
      session,
      ["sh", "-c", "trap '' TERM; echo note-from-lane > /data/note; sleep 1000"],
      "/",
      env,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pid_before = Number((await raw_syscall(session, NR.getpid)).ret);
    console.log(
      `(h) lane session pid ${pid_before}; sleeper ${sleeper.pid}, TERM-ignoring shell ${shell.pid}`,
    );
    await raw_syscall(session, NR.kill, -1, SIG.TERM);
    console.log(`(h) kill(-1, SIGTERM) from the lane @${at()}`);
    console.log(
      `(h) sleeper status 0x${(await reap(session, sleeper.pid)).toString(16)} (signal ${SIG.TERM} expected)`,
    );
    console.log(`(h) caller still alive: getpid = ${(await raw_syscall(session, NR.getpid)).ret}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await raw_syscall(session, NR.kill, -1, SIG.KILL);
    console.log(
      `(h) shell status after kill(-1, SIGKILL): 0x${(await reap(session, shell.pid)).toString(16)}`,
    );
    await raw_syscall(session, NR.sync);
    const mounts = (await readText(session, "/proc/self/mounts"))
      .trim()
      .split("\n")
      .map((line) => line.split(" ")[1]!);
    for (const target of mounts.toReversed()) {
      try {
        if (target === "/") throw new Error("root");
        await umount2(session, target, 0);
        console.log(`(h) umount ${target}`);
      } catch (error) {
        try {
          await mount(session, null, target, null, MS.REMOUNT | MS.RDONLY, null);
          console.log(`(h) remount ro ${target} (${(error as Error).message})`);
        } catch (remount) {
          console.log(`(h) ${target}: ${(remount as Error).message}`);
        }
      }
    }
    console.log(`(h) reboot(RB_POWER_OFF) from the lane @${at()}`);
    void raw_syscall(session, NR.reboot, 0xfee1dead, 672274793, RB.POWER_OFF, 0).catch(() => {});
    await report(machine);
    await check_clean();
    break;
  }
  case "reboot-restart": {
    const { machine, guest } = await boot({ reboot: "restart" });
    console.log(`booted @${at()}, boots=${guest.boots}`);
    console.log(
      JSON.stringify(
        (
          await guest.sh(
            "echo note-before-reboot > /data/note; cat /proc/sys/kernel/random/boot_id",
          )
        ).output,
      ),
    );
    await machine.reboot({ timeoutMs: 30_000 });
    console.log(`machine.reboot() resolved @${at()}, boots=${guest.boots}`);
    console.log(
      JSON.stringify(
        (
          await guest.sh(
            "cat /data/note; cat /proc/sys/kernel/random/boot_id; cut -d' ' -f1 /proc/uptime",
          )
        ).output,
      ),
    );
    console.log("guest runs reboot itself");
    void guest.sh("reboot").catch(() => {});
    const deadline = performance.now() + 30_000;
    while (guest.boots < 3 && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    console.log(`boots=${guest.boots} @${at()}`);
    console.log(
      JSON.stringify(
        (await guest.sh("cat /data/note; cat /proc/sys/kernel/random/boot_id")).output,
      ),
    );
    console.log(`shutdown() -> ${JSON.stringify(await machine.shutdown())}`);
    console.log("console:\n" + agent_lines());
    break;
  }
  default:
    throw new Error(`unknown scenario ${scenario}`);
}
process.exit(0);
