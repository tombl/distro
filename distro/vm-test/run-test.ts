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
import type * as Kernel from "@lowland/kernel";
import { LineDecoder, parseResult, type Result } from "./protocol.ts";

let cpus = 1;
const positional: string[] = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--cpus") {
    cpus = Number(args[++index]);
  } else {
    positional.push(args[index]!);
  }
}
const [linuxPath, initramfsPath, ...diskPaths] = positional;
if (!linuxPath || !initramfsPath || !Number.isSafeInteger(cpus) || cpus < 1) {
  throw new Error("usage: run-test.ts [--cpus <count>] <linux-module> <initramfs> [disk ...]");
}

// The kernel is the store path under test, not a dependency.
const { blockDevice, bootConsole, bootMachine, consoleDevice, entropyDevice }: typeof Kernel =
  await import(pathToFileURL(linuxPath).href);

const { promise: result, resolve: resolveResult } = Promise.withResolvers<Result>();
let settled = false;
let machine: Kernel.Machine | null | undefined;
let initialMemoryBytes = 0;
let observingMemoryGrowth = false;
let memoryGrowthStage = 0;
let previousMemoryBytes = 0;

const KERNEL_MEMORY_MAXIMUM_BYTES = 0xffff * 0x10000;
const MAXIMUM_EXPECTED_INITIAL_MEMORY_BYTES = 16 * 0x100000;

function finish(value: Result) {
  if (settled) return;
  settled = true;
  resolveResult(value);
}

function consumeLine(line: string) {
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

function observeMemoryGrowth(stage: number) {
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

function consoleOutput({ failWhenClosed }: { failWhenClosed: boolean }) {
  const decoder = new LineDecoder();
  return new WritableStream<Uint8Array>({
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

const input = new TransformStream<Uint8Array, Uint8Array>();
const inputWriter = input.writable.getWriter();
const devices: NonNullable<Kernel.BootMachineOptions["plugins"]>[number][] = [
  bootConsole(consoleOutput({ failWhenClosed: false })),
  consoleDevice(input.readable, consoleOutput({ failWhenClosed: true })),
  entropyDevice(),
];

const disks: number[] = [];
for (const diskPath of diskPaths) {
  const disk = openSync(diskPath, "r+");
  disks.push(disk);
  const { size } = fstatSync(disk);
  devices.push(
    blockDevice({
      capacity: size,
      read: async (offset, data) => {
        let read = 0;
        while (read < data.length) {
          const length = readSync(disk, data, read, data.length - read, offset + read);
          if (length === 0) break;
          read += length;
        }
        return read;
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

machine = await bootMachine({
  cpus,
  plugins: devices,
  initcpio: readFileSync(initramfsPath),
}).catch((error) => {
  finish({ passed: false, reason: `machine failed to boot: ${error}` });
  return null;
});

if (machine) initialMemoryBytes = machine.memory.buffer.byteLength;

void machine?.closed.catch((error) => {
  finish({ passed: false, reason: `machine failed: ${error}` });
});

const outcome = await result;
machine?.close();
for (const disk of disks) closeSync(disk);

if (!outcome.passed) console.error(`vm test failed: ${outcome.reason}`);
process.exitCode = outcome.passed ? 0 : 1;
