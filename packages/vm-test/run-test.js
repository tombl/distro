#!/usr/bin/env -S deno run --allow-all

import { pathToFileURL } from "node:url";
import { LineDecoder, parseResult } from "./protocol.js";

const [linuxPath, initramfsPath, diskPath] = Deno.args;
if (!linuxPath || !initramfsPath || Deno.args.length > 3) {
  throw new Error("usage: run-test.js <linux-module> <initramfs> [disk]");
}

const { BlockDevice, ConsoleDevice, EntropyDevice, Machine } = await import(
  pathToFileURL(linuxPath).href
);

let resolveResult;
const result = new Promise((resolve) => {
  resolveResult = resolve;
});
let settled = false;

function finish(value) {
  if (settled) return;
  settled = true;
  resolveResult(value);
}

function consumeLine(line) {
  const testResult = parseResult(line);
  if (testResult) {
    finish(testResult);
  } else if (line.includes("Kernel panic - not syncing")) {
    finish({ passed: false, reason: line });
  }
}

function consoleOutput({ failWhenClosed }) {
  const decoder = new LineDecoder();
  return new WritableStream({
    write(chunk) {
      Deno.stdout.writeSync(chunk);
      for (const line of decoder.write(chunk)) consumeLine(line);
    },
    close() {
      for (const line of decoder.close()) consumeLine(line);
      if (failWhenClosed) {
        finish({ passed: false, reason: "guest console closed before reporting a result" });
      }
    },
    abort(error) {
      finish({ passed: false, reason: `guest console failed: ${error}` });
    },
  });
}

const input = new ReadableStream({
  start(controller) {
    controller.close();
  },
});
const devices = [
  new ConsoleDevice(input, consoleOutput({ failWhenClosed: true })),
  new EntropyDevice(),
];

let disk;
if (diskPath) {
  disk = await Deno.open(diskPath, { read: true, write: true });
  const { size } = await disk.stat();
  devices.push(
    new BlockDevice({
      capacity: size,
      read: async (offset, length) => {
        const data = new Uint8Array(length);
        disk.seekSync(offset, Deno.SeekMode.Start);
        let read = 0;
        while (read < data.length) {
          const length = disk.readSync(data.subarray(read));
          if (length === null) break;
          read += length;
        }
        return data.subarray(0, read);
      },
      write: async (offset, data) => {
        disk.seekSync(offset, Deno.SeekMode.Start);
        let written = 0;
        while (written < data.length) {
          written += disk.writeSync(data.subarray(written));
        }
        return written;
      },
      flush: () => disk.sync(),
    }),
  );
}

const machine = new Machine({
  memoryMib: 128,
  cpus: 1,
  devices,
  initcpio: await Deno.readFile(initramfsPath),
});

machine.bootConsole
  .pipeTo(consoleOutput({ failWhenClosed: false }))
  .catch((error) => finish({ passed: false, reason: `boot console failed: ${error}` }));
machine.on("error", ({ error }) => {
  finish({ passed: false, reason: `machine failed: ${error}` });
});

machine.boot().catch((error) => {
  finish({ passed: false, reason: `machine failed to boot: ${error}` });
});

const timeout = setTimeout(() => {
  finish({ passed: false, reason: "timed out after 15 seconds" });
}, 15_000);

const outcome = await result;
clearTimeout(timeout);
disk?.close();

if (!outcome.passed) console.error(`vm test failed: ${outcome.reason}`);
Deno.exit(outcome.passed ? 0 : 1);
