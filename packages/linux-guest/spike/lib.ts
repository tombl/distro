// PROTOTYPE (redesign phase 0 spike). Rough helpers for the risk spike:
// the agent as an initramfs, a host-driven boot over lane syscalls, and
// switch_root as PID 1's step. Phase 2 redoes all of this properly.
import { readFile } from "node:fs/promises";
import { vsockDevice, type VsockDevice } from "@lowland/kernel";
import type { MachinePlugin } from "@lowland/kernel/plugin";
import { AT, E, O, parse_dirents, SystemError } from "../src/abi.ts";
import { GuestSession } from "../src/conn.ts";
import { create_guest_client } from "../src/client.ts";
import {
  getdents64,
  mkdirat,
  mount,
  openat,
  raw_syscall,
  read,
  switch_root,
  unlinkat,
} from "../src/syscalls.ts";

export const NR = {
  pipe2: 59,
  chdir: 49,
  ioctl: 29,
  kill: 129,
  reboot: 142,
  sync: 81,
  getpid: 172,
} as const;

export const MS = { RDONLY: 1, REMOUNT: 32, BIND: 4096, MOVE: 8192, REC: 16384 } as const;

export const RB = { AUTOBOOT: 0x01234567, POWER_OFF: 0x4321fedc, HALT: 0xcdef0123 } as const;

export const SIG = { KILL: 9, USR1: 10, USR2: 12, TERM: 15 } as const;

/** The prototype agent binary, built from this branch's agent.c. */
export const AGENT_BINARY =
  process.env.SPIKE_AGENT ?? "/var/tmp/linux-api-rethink/spike/agent/bin/linux-guest-agent";

export interface NewcEntry {
  name: string;
  mode: number;
  data?: Uint8Array;
}

/** An uncompressed newc archive with a TRAILER!!!. */
export function newc(entries: readonly NewcEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    length += bytes.byteLength;
    const pad = (4 - (length % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      length += pad;
    }
  };
  const hex = (value: number) => value.toString(16).padStart(8, "0");
  let inode = 1;
  for (const entry of [...entries, { name: "TRAILER!!!", mode: 0 }]) {
    const data = entry.data ?? new Uint8Array();
    const name = encoder.encode(entry.name + "\0");
    const header =
      "070701" +
      [
        entry.name === "TRAILER!!!" ? 0 : inode++,
        entry.mode,
        0, // uid
        0, // gid
        1, // nlink
        0, // mtime
        data.byteLength,
        0,
        0,
        0,
        0, // dev and rdev
        name.byteLength,
        0, // check
      ]
        .map(hex)
        .join("");
    const head = new Uint8Array(header.length + name.byteLength);
    head.set(encoder.encode(header));
    head.set(name, header.length);
    push(head);
    if (data.byteLength) push(data);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function agentCpio(binary = AGENT_BINARY) {
  return newc([{ name: "init", mode: 0o100755, data: await readFile(binary) }]);
}

/** The agent as /init on an initramfs, plus its vsock. No disk, no root=. */
export function initramfsAgent(binary = AGENT_BINARY): {
  plugin: MachinePlugin;
  vsock: VsockDevice;
} {
  const vsock = vsockDevice();
  return {
    vsock,
    plugin: {
      configure(setup) {
        setup.devices.add(vsock);
        setup.initramfs.add(agentCpio(binary));
      },
    },
  };
}

/** Connects a session, retrying until PID 1 accepts. */
export async function connect(vsock: VsockDevice, timeoutMs = 30_000): Promise<GuestSession> {
  const deadline = performance.now() + timeoutMs;
  let failure: unknown;
  do {
    try {
      return await GuestSession.connect(vsock, { timeoutMs: 1000 });
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  throw new Error("agent did not accept a session", { cause: failure });
}

export async function sys(
  session: GuestSession,
  nr: number,
  ...args: Parameters<typeof raw_syscall>[2][]
) {
  return (await raw_syscall(session, nr, ...args)).ret;
}

export async function readText(session: GuestSession, path: string): Promise<string> {
  await using fd = await openat(session, path, O.RDONLY | O.CLOEXEC, 0);
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await read(fd, 4096);
    if (!chunk.byteLength) break;
    chunks.push(chunk.slice());
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function readDir(session: GuestSession, path: string): Promise<string[]> {
  await using fd = await openat(session, path, O.RDONLY | O.DIRECTORY | O.CLOEXEC, 0);
  const names: string[] = [];
  for (;;) {
    const buffer = await getdents64(fd, 8192);
    if (!buffer.byteLength) break;
    names.push(...parse_dirents(buffer).map((entry) => entry.name));
  }
  return names;
}

export async function mkdirp(session: GuestSession, path: string, mode = 0o755) {
  let prefix = "";
  for (const part of path.split("/").filter(Boolean)) {
    prefix += `/${part}`;
    try {
      await mkdirat(session, prefix, mode);
    } catch (error) {
      if (!(error instanceof SystemError && error.code === "EEXIST")) throw error;
    }
  }
}

/** Resolves a disk serial to its /dev node through /sys/block/X/serial. */
export async function disk(session: GuestSession, serial: string): Promise<string> {
  for (const name of await readDir(session, "/sys/block")) {
    let found: string;
    try {
      found = (await readText(session, `/sys/block/${name}/serial`)).trim();
    } catch {
      continue;
    }
    if (found === serial) return `/dev/${name}`;
  }
  throw new SystemError(E.ENODEV);
}

export interface SpikeMount {
  path: string;
  serial?: string;
  tag?: string;
  type: string;
  mode: "rw" | "ro" | "overlay";
  options?: string;
}

/** Steps 3–7 of DESIGN-v3 §3: mount the table under /sysroot and switch. */
export async function hostBoot(
  vsock: VsockDevice,
  mounts: readonly SpikeMount[],
  options: {
    trace?: (step: string) => void;
    memory?: (before: Record<string, string>, after: Record<string, string>) => void;
  } = {},
): Promise<{ boot: GuestSession; trace: [string, number][] }> {
  const trace: [string, number][] = [];
  const mark = (step: string) => {
    trace.push([step, performance.now()]);
    options.trace?.(step);
  };
  const session = await connect(vsock);
  mark("handshake");
  await mkdirp(session, "/proc", 0o555);
  await mkdirp(session, "/sys", 0o555);
  await mount(session, "proc", "/proc", "proc", 0, null);
  await mount(session, "sysfs", "/sys", "sysfs", 0, null);
  await mkdirp(session, "/dev/pts");
  await mount(session, "devpts", "/dev/pts", "devpts", 0, null);
  mark("kernel filesystems");
  await mkdirp(session, "/sysroot");
  for (const [index, entry] of mounts.entries()) {
    const source = entry.serial ? await disk(session, entry.serial) : (entry.tag ?? entry.type);
    const target = `/sysroot${entry.path === "/" ? "" : entry.path}`;
    await mkdirp(session, target);
    if (entry.mode === "overlay") {
      const base = `/run/lowland/m${index}`;
      await mkdirp(session, `${base}/lower`);
      await mount(session, source, `${base}/lower`, entry.type, MS.RDONLY, entry.options ?? null);
      await mkdirp(session, `${base}/rw`);
      await mount(session, "tmpfs", `${base}/rw`, "tmpfs", 0, null);
      await mkdirp(session, `${base}/rw/upper`);
      await mkdirp(session, `${base}/rw/work`);
      await mount(
        session,
        "overlay",
        target,
        "overlay",
        0,
        `lowerdir=${base}/lower,upperdir=${base}/rw/upper,workdir=${base}/rw/work`,
      );
    } else {
      await mount(
        session,
        source,
        target,
        entry.type,
        entry.mode === "ro" ? MS.RDONLY : 0,
        entry.options ?? null,
      );
    }
    mark(`mount ${entry.path}`);
  }
  for (const name of ["dev", "proc", "sys"]) {
    await mkdirp(session, `/sysroot/${name}`);
    await mount(session, `/${name}`, `/sysroot/${name}`, null, MS.MOVE, null);
  }
  mark("move kernel filesystems");
  // The initramfs's own files: the agent and the now-empty mount points.
  const memory = async () =>
    Object.fromEntries(
      (await readText(session, "/sysroot/proc/meminfo"))
        .split("\n")
        .filter((line) => /^(MemFree|Unevictable|Cached):/.test(line))
        .map((line) => line.split(/:\s+/) as [string, string]),
    );
  const before_unlink = options.memory ? await memory() : undefined;
  await unlinkat(session, "/init", 0);
  if (options.memory) options.memory(before_unlink!, await memory());
  for (const name of ["proc", "sys"]) await unlinkat(session, `/${name}`, AT.REMOVEDIR);
  await switch_root(session);
  mark("switch_root validated");
  session.close();
  return { boot: session, trace };
}

/**
 * PROTOTYPE: the initramfs agent as a whole machine plugin. Every boot
 * (reboots included) realizes `mounts` and switches root, and the power hook
 * sends PID 1 BusyBox init's signal over a lane.
 */
export function spikeGuest(mounts: readonly SpikeMount[], binary = AGENT_BINARY) {
  const agent = initramfsAgent(binary);
  let client: ReturnType<typeof create_guest_client> | undefined;
  let boots = 0;
  const plugin: MachinePlugin = {
    configure: agent.plugin.configure,
    async booted() {
      if (mounts.length) await hostBoot(agent.vsock, mounts);
      client = create_guest_client(agent.vsock);
      boots++;
    },
    async power(action) {
      // PID 1 serves one session at a time, so this must use the session
      // the client already holds.
      if (!client) return false;
      await client.signal(1, action === "poweroff" ? SIG.USR2 : SIG.TERM);
      return true;
    },
  };
  const sh = async (command: string) => {
    if (!client) throw new Error("not booted");
    const child = await client.exec(["sh", "-c", command], { cwd: "/" });
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.stdin.close(),
    ]);
    return { status, output: `${stdout}${stderr}` };
  };
  return {
    plugin,
    vsock: agent.vsock,
    sh,
    get client() {
      if (!client) throw new Error("not booted");
      return client;
    },
    get boots() {
      return boots;
    },
  };
}
