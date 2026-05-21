#!/usr/bin/env -S deno run --allow-all
import { BlockDevice, ConsoleDevice, EntropyDevice, Machine } from "@tombl/linux";
import { parseArgs } from "node:util";

function assert(cond: unknown, message = "Assertion failed"): asserts cond {
  if (!cond) throw new Error(message);
}

const args = parseArgs({
  args: Deno.args,
  allowNegative: true,
  options: {
    cmdline: {
      short: "c",
      type: "string",
      default: "",
    },
    memory: {
      short: "m",
      type: "string",
      default: "128",
    },
    initcpio: {
      short: "i",
      type: "string",
    },
    cpus: {
      short: "j",
      type: "string",
      default: "1",
    },
    disk: {
      type: "string",
    },
    timeout: {
      short: "t",
      type: "string",
      default: "30",
    },
    help: {
      short: "h",
      type: "boolean",
      default: false,
    },
  },
}).values;

if (args.help) {
  console.log(`usage: run-test.ts --initcpio <path> --disk <path> [options]

options:
  -c, --cmdline <string>  Command line arguments to pass to the kernel
  -m, --memory <number>   Amount of memory to allocate in MiB
  -i, --initcpio <path>   Path to the initramfs to boot
  -j, --cpus <number>     Number of CPUs to use
      --disk <path>       Path to the rootfs disk image
  -t, --timeout <number>  Timeout in seconds
  -h, --help              Show this help message
`);
  Deno.exit(0);
}

assert(args.initcpio, "initcpio is required");
assert(args.disk, "disk is required");

const memoryMib = parseInt(args.memory, 10);
const cpus = parseInt(args.cpus, 10);
const timeoutSeconds = parseInt(args.timeout, 10);
assert(!Number.isNaN(memoryMib), "memory must be a number");
assert(!Number.isNaN(cpus), "cpus must be a number");
assert(!Number.isNaN(timeoutSeconds), "timeout must be a number");

let settled = false;
let buffer = "";
const decoder = new TextDecoder();

function complete(code: number) {
  if (settled) return;
  settled = true;
  Deno.exit(code);
}

function consume(chunk: Uint8Array) {
  Deno.stdout.writeSync(chunk);
  buffer += decoder.decode(chunk, { stream: true });

  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);

    if (line === "@@TEST-PASS") {
      complete(0);
    } else if (line.startsWith("@@TEST-FAIL")) {
      complete(1);
    }
  }
}

function consoleOutput() {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      consume(chunk);
    },
  });
}

const input = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.close();
  },
});

const file = await Deno.open(args.disk, { read: true, write: true });
const { size } = await file.stat();

const machine = new Machine({
  cmdline: args.cmdline,
  memoryMib,
  cpus,
  devices: [
    new ConsoleDevice(input, consoleOutput()),
    new EntropyDevice(),
    new BlockDevice({
      capacity: size,
      read(offset, length) {
        const array = new Uint8Array(length);
        file.seekSync(offset, Deno.SeekMode.Start);
        let n = 0;
        while (n < array.byteLength) {
          const chunk = file.readSync(array.subarray(n));
          if (chunk === null) break;
          n += chunk;
        }
        return array.subarray(0, n);
      },
      write(offset, data) {
        file.seekSync(offset, Deno.SeekMode.Start);
        let n = 0;
        while (n < data.byteLength) {
          n += file.writeSync(data.subarray(n));
        }
        return n;
      },
      flush() {
        file.sync();
      },
    }),
  ],
  initcpio: await Deno.readFile(args.initcpio),
});

machine.bootConsole.pipeTo(consoleOutput(), { preventClose: true }).catch((error) => {
  console.error(error);
  complete(1);
});

machine.on("error", ({ error }) => {
  console.error(error);
  complete(1);
});

setTimeout(() => {
  console.error(`Timed out after ${timeoutSeconds}s waiting for @@TEST-PASS`);
  complete(1);
}, timeoutSeconds * 1000);

await machine.boot();
