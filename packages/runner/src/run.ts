#!/usr/bin/env -S deno run --allow-all
import { BlockDevice, ConsoleDevice, EntropyDevice, Machine, VsockDevice } from "@tombl/linux";
import { GuestAgentClient } from "./guest_agent.ts";
import { parseArgs } from "node:util";

function assert(cond: unknown, message = "Assertion failed"): asserts cond {
  if (!cond) throw new Error(message);
}

const defaultMemory = navigator.hardwareConcurrency > 16 ? 256 : 128;

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
      default: defaultMemory.toString(),
    },
    initcpio: {
      short: "i",
      type: "string",
      default: new URL("./initramfs.cpio", import.meta.url).pathname,
    },
    cpus: {
      short: "j",
      type: "string",
      default: navigator.hardwareConcurrency.toString(),
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
    "vsock-ping": {
      type: "boolean",
      default: false,
    },
    "guest-agent-smoke": {
      type: "boolean",
      default: false,
    },
  },
}).values;

if (args.help) {
  console.log(`usage: run.ts [options]

options:
  -c, --cmdline <string>  Command line arguments to pass to the kernel
  -m, --memory <number>   Amount of memory to allocate in MiB (default: ${defaultMemory})
  -i, --initcpio <string> Path to the initramfs to boot
  -j, --cpus <number>     Number of CPUs to use (default: number of CPUs on the machine)
      --no-console        Don't attach a console device
      --no-entropy        Don't attach an entropy device
      --disk <string>     Path to a disk image to use (can be specified multiple times)
      --vsock-ping        Connect to the guest init over vsock and verify ping/pong
      --guest-agent-smoke Verify ping, fs, listing, stat, and exec over the guest agent
  -h, --help              Show this help message
`);
  Deno.exit(0);
}

assert(!Number.isNaN(parseInt(args.cpus, 10)), "cpus must be a number");
assert(!Number.isNaN(parseInt(args.memory, 10)), "memory must be a number");

const devices = [];

if (args.console) {
  if (Deno.stdin.isTerminal()) {
    let raw = false;

    const restore = () => {
      if (!raw) return;
      raw = false;
      Deno.stdin.setRaw(false);
    };

    const exitFromSignal = (signal: Deno.Signal, code: number) => {
      Deno.addSignalListener(signal, () => {
        restore();
        Deno.exit(code);
      });
    };

    Deno.stdin.setRaw(true, { cbreak: true });
    raw = true;

    addEventListener("unload", restore);
    exitFromSignal("SIGHUP", 129);
    exitFromSignal("SIGINT", 130);
    exitFromSignal("SIGQUIT", 131);
    exitFromSignal("SIGTERM", 143);
  }

  devices.push(new ConsoleDevice(Deno.stdin.readable, Deno.stdout.writable));
}

if (args.entropy) {
  devices.push(new EntropyDevice());
}

for (const disk of args.disk) {
  let readonly = false;
  const file = await Deno.open(disk, { read: true, write: true }).catch(() => {
    readonly = true;
    return Deno.open(disk, { read: true });
  });
  const { size } = await file.stat();

  devices.push(
    new BlockDevice({
      read: async (offset, length) => {
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
      write: readonly
        ? undefined
        : async (offset, data) => {
            file.seekSync(offset, Deno.SeekMode.Start);
            let n = 0;
            while (n < data.byteLength) {
              n += file.writeSync(data.subarray(n));
            }
            return n;
          },
      flush: () => file.sync(),
      capacity: size,
    }),
  );
}

const vsock = new VsockDevice();
devices.push(vsock);

const machine = new Machine({
  cmdline: args.cmdline,
  memoryMib: parseInt(args.memory, 10),
  cpus: parseInt(args.cpus, 10),
  devices,
  initcpio: await Deno.readFile(args.initcpio),
});

machine.bootConsole.pipeTo(Deno.stderr.writable, { preventClose: true });

machine.on("error", ({ error }) => {
  console.error(error);
});

machine.boot();

async function vsockPing() {
  const agent = new GuestAgentClient(vsock);
  const deadline = Date.now() + 15_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await agent.connect({ timeoutMs: 1000 });
      const reply = await agent.ping();
      await agent.close();

      if (reply !== "pong") {
        throw new Error(`unexpected vsock ping response: ${JSON.stringify(reply)}`);
      }

      console.error("vsock ping: pong");
      Deno.exit(0);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  console.error("vsock ping failed:", lastError);
  Deno.exit(1);
}

async function guestAgentSmoke() {
  const agent = new GuestAgentClient(vsock);
  const deadline = Date.now() + 15_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await agent.connect({ timeoutMs: 1000 });

      console.error("guest agent smoke: ping");
      const ping = await agent.ping();
      assert(ping === "pong", `unexpected ping response: ${JSON.stringify(ping)}`);

      const path = "/tmp/guest-agent-smoke.txt";
      const body = new TextEncoder().encode("hello from host\n");
      console.error("guest agent smoke: write");
      const written = await agent.writeFile(path, body);
      assert(written === BigInt(body.byteLength), `unexpected write count: ${written}`);

      console.error("guest agent smoke: stat");
      const stat = await agent.stat(path);
      assert(stat.kind === "file", `unexpected stat kind: ${stat.kind}`);
      assert(stat.size === BigInt(body.byteLength), `unexpected stat size: ${stat.size}`);

      console.error("guest agent smoke: read");
      const read = await agent.readFile(path);
      assert(new TextDecoder().decode(read) === "hello from host\n", "readback mismatch");

      console.error("guest agent smoke: list");
      const entries = await agent.readDir("/tmp");
      assert(
        entries.some((entry) => entry.name === "guest-agent-smoke.txt"),
        "missing /tmp entry",
      );

      console.error("guest agent smoke: exec");
      const exec = await agent.exec(["/bin/busybox", "cat", path]);
      assert(exec.code === 0, `exec failed with status ${exec.status}`);
      assert(new TextDecoder().decode(exec.stdout) === "hello from host\n", "exec stdout mismatch");
      assert(exec.stderr.byteLength === 0, "exec stderr was not empty");

      await agent.close();
      console.error("guest agent smoke: ok");
      Deno.exit(0);
    } catch (error) {
      lastError = error;
      await agent.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  console.error("guest agent smoke failed:", lastError);
  Deno.exit(1);
}

if (args["vsock-ping"]) {
  void vsockPing();
}

if (args["guest-agent-smoke"]) {
  void guestAgentSmoke();
}
