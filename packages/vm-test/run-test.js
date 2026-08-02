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

let cpus = 1;
const positional = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--cpus") {
    cpus = Number(args[++index]);
  } else {
    positional.push(args[index]);
  }
}
const [linuxPath, initramfsPath, diskPath] = positional;
if (
  !linuxPath ||
  !initramfsPath ||
  positional.length > 3 ||
  !Number.isSafeInteger(cpus) ||
  cpus < 1
) {
  throw new Error("usage: run-test.js [--cpus <count>] <linux-module> <initramfs> [disk]");
}

const { blockDevice, consoleDevice, entropyDevice, spawnMachine, vsockDevice } = await import(
  pathToFileURL(linuxPath).href
);

let resolveResult;
const result = new Promise((resolve) => {
  resolveResult = resolve;
});
let settled = false;
let machine;
let initialMemoryBytes;
let observingMemoryGrowth = false;
let memoryGrowthStage = 0;
let previousMemoryBytes;

const KERNEL_MEMORY_MAXIMUM_BYTES = 0xffff * 0x10000;
const MAXIMUM_EXPECTED_INITIAL_MEMORY_BYTES = 16 * 0x100000;

function finish(value) {
  if (settled) return;
  settled = true;
  resolveResult(value);
}

function consumeLine(line) {
  if (line === "::kernel-memory::ready") {
    observingMemoryGrowth = true;
    console.log(`kernel memory after spawn: ${initialMemoryBytes} bytes`);
    if (initialMemoryBytes >= MAXIMUM_EXPECTED_INITIAL_MEMORY_BYTES) {
      finish({
        passed: false,
        reason: `kernel memory started at ${initialMemoryBytes} bytes instead of growing on demand`,
      });
      return;
    }
    observeMemoryGrowth(0);
    return;
  }
  if (line === "::kernel-memory::sequential") {
    observeMemoryGrowth(1);
    return;
  }

  const testResult = parseResult(line);
  if (testResult) {
    if (observingMemoryGrowth && testResult.passed) observeMemoryGrowth(2);
    finish(testResult);
  } else if (line.includes("Kernel panic - not syncing")) {
    finish({ passed: false, reason: line });
  }
}

function observeMemoryGrowth(stage) {
  if (!machine) {
    finish({ passed: false, reason: "guest reported before machine initialization completed" });
    return;
  }
  if (stage !== memoryGrowthStage) {
    finish({ passed: false, reason: `unexpected kernel memory stage ${stage}` });
    return;
  }

  const current = machine.memory.buffer.byteLength;
  const names = ["ready", "sequential", "concurrent"];
  console.log(`kernel memory after ${names[stage]} stage: ${current} bytes`);
  if (stage > 0 && current <= previousMemoryBytes) {
    finish({
      passed: false,
      reason: `kernel memory did not grow: ${previousMemoryBytes} -> ${current} bytes`,
    });
    return;
  }
  if (current >= KERNEL_MEMORY_MAXIMUM_BYTES) {
    finish({ passed: false, reason: "kernel memory jumped to its maximum" });
    return;
  }

  previousMemoryBytes = current;
  memoryGrowthStage++;
  if (stage < 2) void inputWriter.write(new Uint8Array([0x0a]));
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

// An echo service guests can reach at (VMADDR_CID_HOST, port 7), covering
// guest-initiated vsock connections end to end.
const vsock = vsockDevice();
vsock.listen(7, async (connection) => {
  for (;;) {
    const chunk = await connection.read();
    if (chunk.byteLength === 0) return;
    await connection.write(chunk);
  }
});

const input = new TransformStream();
const inputWriter = input.writable.getWriter();
const devices = [
  consoleDevice(input.readable, consoleOutput({ failWhenClosed: true })),
  entropyDevice(),
  vsock,
];

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

machine = await spawnMachine({
  cpus,
  devices,
  initcpio: readFileSync(initramfsPath),
}).catch((error) => {
  finish({ passed: false, reason: `machine failed to boot: ${error}` });
  return null;
});

if (machine) initialMemoryBytes = machine.memory.buffer.byteLength;

void machine?.bootConsole
  .pipeTo(consoleOutput({ failWhenClosed: false }), { preventClose: true })
  .catch((error) => finish({ passed: false, reason: `boot console failed: ${error}` }));
void machine?.closed.catch((error) => {
  finish({ passed: false, reason: `machine failed: ${error}` });
});

const outcome = await result;
machine?.close();
if (disk !== undefined) closeSync(disk);

if (!outcome.passed) console.error(`vm test failed: ${outcome.reason}`);
process.exitCode = outcome.passed ? 0 : 1;
