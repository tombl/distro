// PROTOTYPE (redesign phase 0 spike), risk (j) for agent-less guests: BusyBox
// init as PID 1, with no agent and no power hook. machine.shutdown() and
// machine.reboot() fall back to the kernel's power button, which runs the
// image's /sbin/poweroff or /sbin/reboot through orderly_poweroff/_reboot.
//   node spike/agentless.ts poweroff|reboot
// The initramfs is two concatenated archives: the busybox boot.cpio, then a
// small one that replaces its /init and adds /etc/inittab.
import { readFile } from "node:fs/promises";
import { bootConsole, bootMachine, consoleDevice } from "@lowland/kernel";
import { testAsset } from "../../../scripts/test-assets.ts";
import { closed_input } from "../tests/helpers.ts";
import { newc } from "./lib.ts";

const action = process.argv[2] ?? "poweroff";
const encoder = new TextEncoder();
const t0 = performance.now();
const at = () => `${(performance.now() - t0).toFixed(0)}ms`;
let log = "";
const ready = Promise.withResolvers<void>();
const sink = () =>
  new WritableStream<Uint8Array>({
    write(chunk) {
      log += new TextDecoder().decode(Uint8Array.from(chunk));
      if (log.includes("agentless-ready")) ready.resolve();
    },
  });

// This BusyBox build has no init applet, so PID 1 is a shell that handles
// BusyBox init's power signals the way init would.
const init = `#!/bin/busybox sh
export PATH=/bin:/sbin
mount -t proc proc /proc
mount -t devtmpfs devtmpfs /dev
down() { echo "agentless-shutdown: $1"; kill -TERM -1; sleep 0.2; kill -KILL -1; sync; umount -a -r 2>/dev/null; $1 -f; }
trap 'down poweroff' USR2
trap 'down poweroff' USR1
trap 'down reboot' TERM
echo agentless-ready
while :; do sleep 1 & wait $!; done
`;
const overlay = newc([{ name: "init", mode: 0o100755, data: encoder.encode(init) }]);

const machine = await bootMachine({
  cpus: 1,
  reboot: "exit",
  plugins: [
    bootConsole(sink()),
    {
      configure(setup) {
        setup.initramfs.add(testAsset("boot.cpio").then((path) => readFile(path)));
        setup.initramfs.add(overlay);
      },
    },
    consoleDevice(closed_input(), sink()),
  ],
});
void machine.exited.then((exit) => {
  console.log(
    `exited early: ${JSON.stringify(exit, (_k, v) => (v instanceof Error ? v.message : v))}\n${log.split("\n").slice(-25).join("\n")}`,
  );
});
await ready.promise;
console.log(`busybox init ready @${at()}; pressing the power button (${action})`);
if (action === "poweroff") {
  console.log(
    `shutdown() -> ${JSON.stringify(await machine.shutdown({ timeoutMs: 15_000 }))} @${at()}`,
  );
} else {
  await machine
    .reboot({ timeoutMs: 15_000 })
    .catch((error) => console.log(`reboot(): ${error.message}`));
  console.log(`exited -> ${JSON.stringify(await machine.exited)} @${at()}`);
}
console.log(
  "console:\n" +
    log
      .split("\n")
      .filter((line) => /agentless|init|reboot|power|Power|restart|halt|sending|SIG/i.test(line))
      .map((line) => `  ${line}`)
      .join("\n"),
);
process.exit(0);
