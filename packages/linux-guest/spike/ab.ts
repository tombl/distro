// PROTOTYPE (redesign phase 0 spike), risks (a) and (b): the agent runs as
// /init from an initramfs with no agent disk and no root=, the host mounts
// the root image under /sysroot over lane syscalls, and PID 1 switches root
// between sessions.
import { blockDevice, bootConsole, bootMachine, consoleDevice } from "@lowland/kernel";
import { closed_input } from "../tests/helpers.ts";
import { readlinkat } from "../src/syscalls.ts";
import { create_guest_client } from "../src/client.ts";
import { rootfs } from "../tests/assets.ts";
import { connect, hostBoot, initramfsAgent, readText } from "./lib.ts";

let log = "";
const decoder = new TextDecoder();
const agent = initramfsAgent();
const root = blockDevice(
  {
    capacity: rootfs.byteLength,
    read(offset, target) {
      const source = rootfs.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  },
  { serial: "m0" },
);
const machine = await bootMachine({
  cpus: 2,
  plugins: [
    bootConsole(
      new WritableStream({
        write(chunk) {
          log += decoder.decode(Uint8Array.from(chunk));
        },
      }),
    ),
    agent.plugin,
    root,
    consoleDevice(
      closed_input(),
      new WritableStream({
        write(chunk) {
          log += decoder.decode(Uint8Array.from(chunk));
        },
      }),
    ),
  ],
});

// (a) Before the host boot: what PID 1 is, and what the kernel was given.
{
  const session = await connect(agent.vsock);
  const { mount } = await import("../src/syscalls.ts");
  const { mkdirp } = await import("./lib.ts");
  await mkdirp(session, "/proc", 0o555);
  await mount(session, "proc", "/proc", "proc", 0, null);
  const exe = decoder.decode(await readlinkat(session, "/proc/1/exe", 256));
  const cmdline = (await readText(session, "/proc/cmdline")).trim();
  const shmem = (await readText(session, "/proc/meminfo")).match(/Shmem:\s+(\d+ kB)/)?.[1];
  const mounts = await readText(session, "/proc/mounts");
  console.log(`(a) /proc/1/exe = ${exe}`);
  console.log(`(a) /proc/cmdline = ${cmdline}`);
  console.log(`(a) Shmem before boot = ${shmem}`);
  console.log(`(a) mounts:\n${mounts}`);
  const { umount2 } = await import("../src/syscalls.ts");
  await umount2(session, "/proc", 0);
  session.close();
}

const { trace } = await hostBoot(
  agent.vsock,
  [
    { path: "/", serial: "m0", type: "erofs", mode: "overlay" },
    { path: "/run", type: "tmpfs", mode: "rw" },
    { path: "/tmp", type: "tmpfs", mode: "rw" },
  ],
  {
    memory: (before, after) =>
      console.log(
        `(b) unlink /init: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`,
      ),
  },
);
console.log(
  "(b) host boot steps:",
  trace.map(([step, at]) => `${step} @${(at - trace[0]![1]).toFixed(1)}ms`).join(", "),
);

process.on("uncaughtException", (error) => {
  console.log("FAILED:", error, "\nlog:\n" + log.split("\n").slice(-30).join("\n"));
  process.exit(1);
});
// (b) A new session sees the new root.
const client = create_guest_client(agent.vsock);
const run = async (argv: string[]) => {
  const child = await client.exec(argv, { cwd: "/" });
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.stdin.close(),
  ]);
  return { status, stdout, stderr };
};
console.log("(b) cat /etc/os-release:", JSON.stringify(await run(["cat", "/etc/os-release"])));
console.log("(b) ls /:", JSON.stringify((await run(["ls", "/"])).stdout));
console.log("(b) readlink /proc/1/exe:", (await run(["readlink", "/proc/1/exe"])).stdout.trim());
console.log("(b) /proc/mounts:\n" + (await run(["cat", "/proc/mounts"])).stdout);
console.log("(b) df /:", (await run(["df", "/"])).stdout);
console.log(
  "(b) Shmem after switch:",
  (await run(["grep", "Shmem:", "/proc/meminfo"])).stdout.trim(),
);
console.log(
  "(b) ramfs control, 1 MiB file in /run created then unlinked:",
  JSON.stringify(
    (
      await run([
        "sh",
        "-c",
        "free_kb() { sed -n 's/^MemFree: *\\([0-9]*\\).*/\\1/p' /proc/meminfo; }; a=$(free_kb); dd if=/dev/zero of=/run/blob bs=64k count=16 2>/dev/null; b=$(free_kb); rm /run/blob; c=$(free_kb); echo before=$a written=$b unlinked=$c",
      ])
    ).stdout.trim(),
  ),
);
console.log(
  "(b) write /etc test:",
  JSON.stringify(await run(["sh", "-c", "echo hi > /etc/spike && cat /etc/spike"])),
);

machine.close();
await machine.closed;
console.log(
  "boot log tail:\n" +
    log
      .split("\n")
      .filter((line) => /initrd|initramfs|agent|Run \/init|VFS|switch/i.test(line))
      .join("\n"),
);
