#!/usr/bin/env node

import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { LineDecoder, parseResult } from "./protocol.js";

const [linuxPath, initramfsPath, diskPath] = process.argv.slice(2);
if (!linuxPath || !initramfsPath || process.argv.length > 5) {
  throw new Error("usage: run-test.js <linux-module> <initramfs> [disk]");
}

const { blockDevice, consoleDevice, entropyDevice, spawnMachine } = await import(
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
      process.stdout.write(chunk);
      for (const line of decoder.write(chunk)) consumeLine(line);
    },
    close() {
      for (const line of decoder.close()) consumeLine(line);
      if (failWhenClosed) {
        finish({
          passed: false,
          reason: "guest console closed before reporting a result",
        });
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
const devices = [consoleDevice(input, consoleOutput({ failWhenClosed: true })), entropyDevice()];

let disk;
if (diskPath) {
  disk = openSync(diskPath, "r+");
  const { size } = fstatSync(disk);
  devices.push(
    blockDevice({
      capacity: size,
      read: async (offset, length) => {
        const data = new Uint8Array(length);
        let read = 0;
        while (read < data.length) {
          const length = readSync(disk, data, read, data.length - read, offset + read);
          if (length === 0) break;
          read += length;
        }
        return data.subarray(0, read);
      },
      write: async (offset, data) => {
        let written = 0;
        while (written < data.length) {
          written += writeSync(disk, data, written, data.length - written, offset + written);
        }
        return written;
      },
      flush: async () => fsyncSync(disk),
    }),
  );
}

const machine = await spawnMachine({
  memoryMib: 128,
  cpus: 1,
  devices,
  initcpio: readFileSync(initramfsPath),
}).catch((error) => {
  finish({ passed: false, reason: `machine failed to boot: ${error}` });
  return null;
});

void machine?.bootConsole
  .pipeTo(consoleOutput({ failWhenClosed: false }), { preventClose: true })
  .catch((error) => finish({ passed: false, reason: `boot console failed: ${error}` }));
void machine?.closed.catch((error) => {
  finish({ passed: false, reason: `machine failed: ${error}` });
});

const timeout = setTimeout(() => {
  finish({ passed: false, reason: "timed out after 15 seconds" });
}, 15_000);

const outcome = await result;
clearTimeout(timeout);
machine?.close();
if (disk !== undefined) closeSync(disk);

if (!outcome.passed) console.error(`vm test failed: ${outcome.reason}`);
process.exitCode = outcome.passed ? 0 : 1;
