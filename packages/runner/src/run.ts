#!/usr/bin/env node
import { blockDevice, consoleDevice, entropyDevice, spawnMachine } from "@tombl/linux";
import { closeSync, fstatSync, fsync, openSync, readSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";

function assert(cond: unknown, message = "Assertion failed"): asserts cond {
  if (!cond) throw new Error(message);
}

const cpus = availableParallelism();

const args = parseArgs({
  args: process.argv.slice(2),
  allowNegative: true,
  options: {
    cmdline: {
      short: "c",
      type: "string",
      default: "",
    },
    initcpio: {
      short: "i",
      type: "string",
      default: new URL("./initramfs.cpio", import.meta.url).pathname,
    },
    cpus: {
      short: "j",
      type: "string",
      default: cpus.toString(),
    },
    help: {
      short: "h",
      type: "boolean",
      default: false,
    },
    console: {
      type: "boolean",
      default: true,
    },
    entropy: {
      type: "boolean",
      default: true,
    },
    disk: {
      type: "string",
      default: [],
      multiple: true,
    },
  },
}).values;

if (args.help) {
  console.log(`usage: run.ts [options]

options:
  -c, --cmdline <string>  Command line arguments to pass to the kernel
  -i, --initcpio <string> Path to the initramfs to boot
  -j, --cpus <number>     Number of CPUs to use (default: number of CPUs on the machine)
      --no-console        Don't attach a console device
      --no-entropy        Don't attach an entropy device
      --disk <string>     Path to a disk image to use (can be specified multiple times)
  -h, --help              Show this help message
`);
  process.exit(0);
}

assert(!Number.isNaN(parseInt(args.cpus, 10)), "cpus must be a number");

const devices = [];
let restoreTerminal = () => {};

if (args.console) {
  if (process.stdin.isTTY) {
    let raw = false;

    restoreTerminal = () => {
      if (!raw) return;
      raw = false;
      process.stdin.setRawMode(false);
    };

    const exitFromSignal = (signal: NodeJS.Signals, code: number) => {
      process.on(signal, () => {
        restoreTerminal();
        process.exit(code);
      });
    };

    process.stdin.setRawMode(true);
    raw = true;

    process.on("exit", restoreTerminal);
    exitFromSignal("SIGHUP", 129);
    exitFromSignal("SIGINT", 130);
    exitFromSignal("SIGQUIT", 131);
    exitFromSignal("SIGTERM", 143);
  }

  const device = consoleDevice(
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  );
  devices.push(device);
}

if (args.entropy) {
  devices.push(entropyDevice());
}

for (const disk of args.disk) {
  let readonly = false;
  let file: number;
  try {
    file = openSync(disk, "r+");
  } catch {
    readonly = true;
    file = openSync(disk, "r");
  }
  const { size } = fstatSync(file);

  process.on("exit", () => closeSync(file));

  devices.push(
    blockDevice({
      read: async (offset, length) => {
        const array = new Uint8Array(length);
        let n = 0;
        while (n < array.byteLength) {
          const read = readSync(file, array, n, array.byteLength - n, offset + n);
          if (read === 0) break;
          n += read;
        }
        return array.subarray(0, n);
      },
      write: readonly
        ? undefined
        : async (offset, data) => {
            let n = 0;
            while (n < data.byteLength) {
              n += writeSync(file, data, n, data.byteLength - n, offset + n);
            }
            return n;
          },
      flush: () =>
        new Promise<void>((resolve, reject) => {
          fsync(file, (error) => (error ? reject(error) : resolve()));
        }),
      capacity: size,
    }),
  );
}

const machine = await spawnMachine({
  cmdline: args.cmdline,
  cpus: parseInt(args.cpus, 10),
  devices,
  initcpio: await readFile(args.initcpio),
});

const bootConsole = machine.bootConsole
  .pipeTo(Writable.toWeb(process.stderr) as WritableStream<Uint8Array>, {
    preventClose: true,
  })
  .catch(() => {});

try {
  await machine.closed;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  restoreTerminal();
  if (args.console) process.stdin.pause();
  await bootConsole;
}
