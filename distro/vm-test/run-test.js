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
const [linuxPath, initramfsPath, ...diskPaths] = positional;
if (!linuxPath || !initramfsPath || !Number.isSafeInteger(cpus) || cpus < 1) {
  throw new Error("usage: run-test.js [--cpus <count>] <linux-module> <initramfs> [disk ...]");
}

const { blockDevice, bootConsole, bootMachine, consoleDevice, entropyDevice, vsockDevice } =
  await import(pathToFileURL(linuxPath).href);

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
let readyMemoryBytes;
let stepMemoryBytes;
let stepsWithGrowth = 0;

const KERNEL_MEMORY_MAXIMUM_BYTES = 0xffff * 0x10000;
const MAXIMUM_EXPECTED_INITIAL_MEMORY_BYTES = 16 * 0x100000;
// The guest writes 64 MiB in 1 MiB steps. Growing to exactly the pages in use
// grows in nearly every step; growing geometrically, in a few.
const MAXIMUM_STEPS_WITH_GROWTH = 8;

const VSOCK_ECHO_PORT = 7;
const VSOCK_CONNECT_MARKER = "::vsock::connect ";
const VSOCK_DIAL_TIMEOUT_MS = 30_000;
const VSOCK_DIAL_RETRY_MS = 10;

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
  if (line === "::kernel-memory::step") {
    if (memoryGrowthStage !== 1) {
      finish({ passed: false, reason: "guest reported a step outside the sequential stage" });
      return;
    }
    const current = machine.memory.buffer.byteLength;
    if (current > (stepMemoryBytes ?? previousMemoryBytes)) stepsWithGrowth++;
    stepMemoryBytes = current;
    void inputWriter.write(new Uint8Array([0x0a]));
    return;
  }
  if (line === "::kernel-memory::sequential") {
    console.log(`kernel memory grew in ${stepsWithGrowth} sequential steps`);
    if (stepsWithGrowth > MAXIMUM_STEPS_WITH_GROWTH) {
      finish({
        passed: false,
        reason: `kernel memory grew in ${stepsWithGrowth} of 64 steps instead of a few large ones`,
      });
      return;
    }
    observeMemoryGrowth(1);
    return;
  }
  if (line.startsWith(VSOCK_CONNECT_MARKER)) {
    const port = Number(line.slice(VSOCK_CONNECT_MARKER.length));
    if (!Number.isSafeInteger(port) || port <= 0) {
      finish({ passed: false, reason: `guest asked for a bad vsock port: ${line}` });
      return;
    }
    void serveGuestListener(port).catch((error) => {
      finish({ passed: false, reason: `serving guest vsock port ${port} failed: ${error}` });
    });
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
  // Growth is geometric, so the sequential write can fit in the headroom an
  // earlier doubling left; by the end of the concurrent stage, memory must
  // have grown past its size at the ready stage.
  if (stage === 1 && current < previousMemoryBytes) {
    finish({
      passed: false,
      reason: `kernel memory shrank: ${previousMemoryBytes} -> ${current} bytes`,
    });
    return;
  }
  if (stage === 2 && current <= readyMemoryBytes) {
    finish({
      passed: false,
      reason: `kernel memory did not grow: ${readyMemoryBytes} -> ${current} bytes`,
    });
    return;
  }
  if (current >= KERNEL_MEMORY_MAXIMUM_BYTES) {
    finish({ passed: false, reason: "kernel memory jumped to its maximum" });
    return;
  }

  if (stage === 0) readyMemoryBytes = current;
  previousMemoryBytes = current;
  memoryGrowthStage++;
  if (stage < 2) void inputWriter.write(new Uint8Array([0x0a]));
}

function consoleOutput({ failWhenClosed }) {
  const decoder = new LineDecoder();
  // The guest's terminal ends lines with CRLF, and a Nix build log takes the
  // carriage return as a return to the start of the line, which blanks every
  // console line, failure reasons included. Echo LF line endings instead.
  let carriageReturn = false;
  return new WritableStream({
    write(chunk) {
      const echoed = [];
      for (const byte of chunk) {
        if (carriageReturn && byte !== 0x0a) echoed.push(0x0d);
        carriageReturn = byte === 0x0d;
        if (!carriageReturn) echoed.push(byte);
      }
      process.stdout.write(Uint8Array.from(echoed));
      for (const line of decoder.write(chunk)) consumeLine(line);
    },
    close() {
      if (carriageReturn) process.stdout.write("\r");
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
// guest-initiated vsock connections end to end. Reading zero bytes means the
// guest half-closed, so the echo is drained before the connection goes away.
async function echo(connection) {
  for (;;) {
    const chunk = await connection.read();
    if (chunk.byteLength === 0) return;
    await connection.write(chunk);
  }
}

const vsock = vsockDevice();
vsock.listen(VSOCK_ECHO_PORT, echo);

// The other direction: a guest that wants to be connected to prints
// "::vsock::connect <port>" and the runner dials that guest port and echoes
// there instead. AF_VSOCK has no /proc listing, so neither side can watch for
// the listener to appear; the guest is free to print the marker before it
// binds, and an unbound guest port resets rather than hangs, so this simply
// redials until the listener answers.
async function dialGuest(port) {
  const deadline = Date.now() + VSOCK_DIAL_TIMEOUT_MS;
  for (;;) {
    try {
      return await vsock.connect(port, { timeoutMs: VSOCK_DIAL_TIMEOUT_MS });
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, VSOCK_DIAL_RETRY_MS));
    }
  }
}

async function serveGuestListener(port) {
  const connection = await dialGuest(port);
  try {
    await echo(connection);
  } finally {
    connection.close();
  }
}

const input = new TransformStream();
const inputWriter = input.writable.getWriter();
const devices = [
  bootConsole(consoleOutput({ failWhenClosed: false })),
  consoleDevice(input.readable, consoleOutput({ failWhenClosed: true })),
  entropyDevice(),
  vsock,
];

const disks = [];
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
  plugins: [{ configure: (setup) => setup.initramfs.add(readFileSync(initramfsPath)) }, ...devices],
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
