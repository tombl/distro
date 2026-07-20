#!/usr/bin/env node
import * as Linux from "@tombl/linux";
import type { VirtioDevice } from "@tombl/linux";
import { closeSync, fstatSync, fsync, openSync, readSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";

const { blockDevice, consoleDevice, entropyDevice, spawnMachine } = Linux;

type FramebufferDevice = VirtioDevice & {
  readonly width: number;
  readonly height: number;
  readRgba(target?: Uint8ClampedArray): Uint8ClampedArray;
};

type InputDevice = VirtioDevice & {
  enqueueKeyEvent(code: number, pressed: boolean): void;
  enqueueRelativeEvent(axis: number, value: number): void;
  enqueueButtonEvent(code: number, pressed: boolean): void;
  enqueueWheelEvent(delta: number): void;
};

// REFERENCE: these factories describe the modern, spawn-time device shape for
// the old spike. The pinned @tombl/linux does not export them yet, so callers
// get a clear error only when graphical support is explicitly requested.
const graphicalLinux = Linux as typeof Linux & {
  framebufferDevice?: (options: { width: number; height: number }) => FramebufferDevice;
  inputDevice?: (options: { kind: "keyboard" | "mouse" }) => InputDevice;
};

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
    graphics: {
      type: "boolean",
      default: false,
    },
    input: {
      type: "boolean",
      default: false,
    },
    "gpu-width": {
      type: "string",
      default: "1024",
    },
    "gpu-height": {
      type: "string",
      default: "768",
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
      --graphics          Attach a simple framebuffer device
      --input             Attach virtio keyboard and mouse devices
      --gpu-width <px>    Framebuffer width with --graphics (default: 1024)
      --gpu-height <px>   Framebuffer height with --graphics (default: 768)
  -h, --help              Show this help message
`);
  process.exit(0);
}

assert(!Number.isNaN(parseInt(args.cpus, 10)), "cpus must be a number");
const framebufferWidth = parseInt(args["gpu-width"], 10);
const framebufferHeight = parseInt(args["gpu-height"], 10);
assert(Number.isInteger(framebufferWidth) && framebufferWidth > 0, "gpu-width must be positive");
assert(Number.isInteger(framebufferHeight) && framebufferHeight > 0, "gpu-height must be positive");

const devices: VirtioDevice[] = [];
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

  if (process.stdout.isTTY) {
    const resize = () => {
      const { columns, rows } = process.stdout;
      if (columns > 0 && rows > 0) device.resize(columns, rows);
    };
    resize();
    process.stdout.on("resize", resize);
  }
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

if (args.graphics) {
  assert(
    graphicalLinux.framebufferDevice,
    "graphics requested but @tombl/linux has no framebufferDevice factory",
  );
  devices.push(
    graphicalLinux.framebufferDevice({
      width: framebufferWidth,
      height: framebufferHeight,
    }),
  );
}

if (args.input) {
  assert(graphicalLinux.inputDevice, "input requested but @tombl/linux has no inputDevice factory");
  devices.push(
    graphicalLinux.inputDevice({ kind: "keyboard" }),
    graphicalLinux.inputDevice({ kind: "mouse" }),
  );
}

// REFERENCE (not runnable in this runner): f9240288b8a2 also extended its
// now-removed --guest-agent-smoke mode with these guest assertions:
//
//   test -c /dev/fb0 && cat /sys/class/graphics/fb0/name  # expected "simple"
//   test -c /dev/input/event0 && test -c /dev/input/event1
//
// Keep them beside the host-device wiring so a future guest-agent integration
// can restore the end-to-end checks without rediscovering the guest contract.

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
