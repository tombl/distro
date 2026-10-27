// PROTOTYPE (redesign phase 0 spike), risks (f) and (g).
// (f) A NodeFS share as the read-only lower of an overlay with a tmpfs upper:
//     guest writes are visible in the guest and absent on the host.
// (g) A terminal the host makes with lane syscalls (open /dev/ptmx,
//     TIOCSPTLCK, TIOCGPTN, TIOCSWINSZ), and pipes from pipe2, handed to a
//     process by the kind 6 spawn's file actions and POSIX_SPAWN_SETSID.
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockDevice, bootConsole, bootMachine, fileSystemDevice } from "@lowland/kernel";
import { O } from "../src/abi.ts";
import { NodeFS } from "../src/node.ts";
import { GuestFd, openat, raw_syscall, read, reap, spawn_actions, write } from "../src/syscalls.ts";
import { rootfs } from "../tests/assets.ts";
import { connect, hostBoot, initramfsAgent, NR } from "./lib.ts";

const decoder = new TextDecoder();
let log = "";
const share = await mkdtemp(join(tmpdir(), "p0-share-"));
await writeFile(join(share, "from-host.txt"), "written on the host\n");

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
    fileSystemDevice(new NodeFS(share, { readOnly: true }), { tag: "m3" }),
  ],
});
await hostBoot(agent.vsock, [
  { path: "/", serial: "m0", type: "erofs", mode: "overlay" },
  { path: "/run", type: "tmpfs", mode: "rw" },
  { path: "/tmp", type: "tmpfs", mode: "rw" },
  { path: "/data", tag: "m3", type: "virtiofs", mode: "overlay" },
]);

const session = await connect(agent.vsock);
const env = ["PATH=/bin:/usr/bin:/sbin:/usr/sbin", "HOME=/root"];

// Runs a command on host-made pipes: kind 6 with dup2 file actions.
async function run(argv: string[]) {
  const pipe = async () => {
    const { out } = await raw_syscall(session, NR.pipe2, { out: 8 }, O.CLOEXEC);
    const view = new DataView(out[0]!.buffer, out[0]!.byteOffset);
    return [
      new GuestFd(session, view.getInt32(0, true)),
      new GuestFd(session, view.getInt32(4, true)),
    ];
  };
  const [in_r, in_w] = await pipe();
  const [out_r, out_w] = await pipe();
  const pid = await spawn_actions(session, {
    argv,
    cwd: "/",
    env,
    actions: [
      { op: "dup2", from: in_r!, fd: 0 },
      { op: "dup2", from: out_w!, fd: 1 },
      { op: "dup2", from: out_w!, fd: 2 },
    ],
  });
  await in_r!.close();
  await out_w!.close();
  await in_w!.close();
  let output = "";
  for (;;) {
    const chunk = await read(out_r!, 4096);
    if (!chunk.byteLength) break;
    output += decoder.decode(chunk);
  }
  await out_r!.close();
  const status = await reap(session, pid);
  return { status, output };
}

console.log(
  "(f) /proc/mounts /data:",
  (await run(["grep", " /data ", "/proc/mounts"])).output.trim(),
);
console.log(
  "(f) guest reads host file:",
  JSON.stringify((await run(["cat", "/data/from-host.txt"])).output),
);
console.log(
  "(f) guest writes:",
  JSON.stringify(
    (
      await run([
        "sh",
        "-c",
        "echo guest > /data/from-guest.txt && echo changed >> /data/from-host.txt && cat /data/from-guest.txt /data/from-host.txt",
      ])
    ).output,
  ),
);
console.log("(f) host directory after guest writes:", await readdir(share));
console.log(
  "(f) host file after guest append:",
  JSON.stringify(await readFile(join(share, "from-host.txt"), "utf8")),
);

// (g) The host makes the terminal.
const TIOCGPTN = 0x80045430;
const TIOCSPTLCK = 0x40045431;
const TIOCSWINSZ = 0x5414;
const ptmx = await openat(session, "/dev/ptmx", O.RDWR | O.CLOEXEC | 0o400 /* O_NOCTTY */, 0);
await raw_syscall(session, NR.ioctl, ptmx, TIOCSPTLCK, { in: new Uint8Array(4) });
const { out } = await raw_syscall(session, NR.ioctl, ptmx, TIOCGPTN, { out: 4 });
const index = new DataView(out[0]!.buffer, out[0]!.byteOffset).getUint32(0, true);
const winsize = new Uint8Array(8);
new DataView(winsize.buffer).setUint16(0, 31, true); // rows
new DataView(winsize.buffer).setUint16(2, 101, true); // columns
await raw_syscall(session, NR.ioctl, ptmx, TIOCSWINSZ, { in: winsize });
const pts = `/dev/pts/${index}`;
console.log(`(g) host made ${pts}`);
const pid = await spawn_actions(session, {
  argv: [
    "sh",
    "-c",
    "tty; stty size; test -t 0 && echo stdin-is-a-tty; set -- $(cat /proc/$$/stat); echo pid=$1 sid=$6 tty_nr=$7; exec 3</dev/tty && echo opened-/dev/tty; exit 7",
  ],
  cwd: "/",
  env: [...env, "TERM=xterm"],
  setsid: true,
  actions: [
    { op: "open", fd: 0, path: pts, flags: O.RDWR },
    { op: "dup2", from: 0, fd: 1 },
    { op: "dup2", from: 0, fd: 2 },
  ],
});
let terminal = "";
for (;;) {
  try {
    const chunk = await read(ptmx, 4096);
    if (!chunk.byteLength) break;
    terminal += decoder.decode(chunk);
  } catch (error) {
    // EIO once every holder of the subsidiary has closed it.
    terminal += `[${(error as Error).message}]`;
    break;
  }
}
const status = await reap(session, pid);
console.log(`(g) terminal output: ${JSON.stringify(terminal)}`);
console.log(`(g) wait status 0x${status.toString(16)} (exit ${status >> 8})`);
await write(ptmx, new Uint8Array()).catch(() => {});
await ptmx.close();
session.close();
machine.close();
await machine.closed;
