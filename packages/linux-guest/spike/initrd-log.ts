// PROTOTYPE (phase 0 spike): boot the busybox lifecycle initramfs through
// setup.initramfs and print the kernel log lines about the initrd.
import { bootConsole, bootMachine, consoleDevice } from "@lowland/kernel";
import { lifecycle_assets } from "../tests/assets.ts";
import { closed_input } from "../tests/helpers.ts";

let log = "";
const sink = () =>
  new WritableStream<Uint8Array>({
    write(chunk) {
      log += new TextDecoder().decode(Uint8Array.from(chunk));
    },
  });
const machine = await bootMachine({
  args: ["lifecycle=poweroff"],
  cpus: 1,
  plugins: [
    bootConsole(sink()),
    lifecycle_assets.boot(),
    lifecycle_assets.root(),
    consoleDevice(closed_input(), sink()),
  ],
});
await machine.closed;
console.log(
  log
    .split("\n")
    .filter((line) => /initrd|initramfs|Memory:|lifecycle|poweroff|Run \/init/i.test(line))
    .join("\n"),
);
