import {
  blockDevice,
  diskStorage,
  fileSystemDevice,
  vsockDevice,
  type DiskSource,
  type FS,
  type Machine,
} from "@lowland/kernel";
import {
  machinePlugin,
  type MachinePlugin,
  type MachinePluginProvider,
  type MachineSetup,
} from "@lowland/kernel/plugin";
import { E, MountFlags, SystemError, UnmountFlags } from "./abi.ts";
import {
  create_guest_client,
  type Exec,
  type ExecOptions,
  type FileSystem,
  type GuestClientCapabilities,
  type Mount as MountCall,
  type Unmount,
} from "./client.ts";
import { check_agent_initramfs } from "./agent-initramfs.ts";
import { platform } from "./platform.ts";
import type { ChildProcess, CommandStatus } from "./process.ts";

let agent_initramfs: Promise<Uint8Array<ArrayBuffer>> | undefined;

async function read_agent_initramfs() {
  const url = new URL("../agent.cpio", import.meta.url);
  const asset = await platform.load_asset(url);
  check_agent_initramfs(url, asset);
  return asset.bytes;
}

function load_agent_initramfs() {
  if (!agent_initramfs) {
    agent_initramfs = read_agent_initramfs();
    // A failed load must not poison later machines.
    agent_initramfs.catch(() => (agent_initramfs = undefined));
  }
  return agent_initramfs;
}

async function wait_for_guest(client: GuestClientCapabilities, machine: Machine) {
  let machine_ended = false;
  const ended = machine.closed.then(
    () => {
      machine_ended = true;
      throw new Error("machine closed before guest agent became ready");
    },
    (error) => {
      machine_ended = true;
      throw error;
    },
  );

  const deadline = performance.now() + 30_000;
  let failure: unknown;
  do {
    try {
      await Promise.race([client.ping(1000), ended]);
      return;
    } catch (error) {
      if (machine_ended) throw error;
      failure = error;
    }
    await Promise.race([new Promise((resolve) => setTimeout(resolve, 25)), ended]);
  } while (performance.now() < deadline);
  throw new Error("guest agent did not become ready", { cause: failure });
}

async function sync_before_close(client: GuestClientCapabilities, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("guest did not sync its filesystems before close")),
      timeoutMs,
    );
  });
  try {
    await Promise.race([client.sync(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function collect(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The collected result of a guest command. Nonzero exit status does not reject `run()`. */
export interface RunResult {
  readonly status: CommandStatus;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/** What a mount entry mounts: a disk, or a filesystem shared over virtio-fs. */
export type MountSource = DiskSource | FS<object, any>;

/**
 * One entry of the mount table that the default boot realizes, like a line
 * of fstab.
 *
 * @example A writable data disk and a scratch tmpfs
 * ```ts
 * const mounts: Mount[] = [
 *   rootImage(),
 *   { path: "/data", source: "data.ext4", type: "ext4" },
 *   { path: "/scratch", type: "tmpfs" },
 * ];
 * ```
 */
export interface Mount {
  /** The absolute, normalized guest path to mount at. `/` is the root. */
  readonly path: string;
  /**
   * What to mount: a disk source, attached as a block device, or a `FS`,
   * attached as a virtio-fs device. Absent for filesystems with no device,
   * such as `tmpfs`, which need a `type`.
   */
  readonly source?: MountSource;
  /**
   * The filesystem type. Without one, a disk is tried with each filesystem
   * the guest kernel supports on block devices, as BusyBox `mount` does, and
   * a shared filesystem is `virtiofs`.
   */
  readonly type?: string;
  /**
   * How the storage is opened and mounted. Defaults to `"rw"`.
   *
   * - `"rw"` opens the storage writable and mounts it read-write.
   * - `"ro"` opens it read-only and mounts it read-only.
   * - `"overlay"` opens it read-only and mounts it beneath a temporary
   *   writable layer in guest memory, so the guest can write to it but the
   *   storage never changes and the writes last only as long as the boot.
   *
   * A filesystem that needs to write to read-only storage fails to mount,
   * such as an ext4 image whose journal needs recovery.
   */
  readonly mode?: "rw" | "ro" | "overlay";
  /** Filesystem-specific mount options, passed to the kernel as mount data. */
  readonly options?: string;
}

/**
 * The Lowland guest-agent integration and the capabilities bound to its
 * private vsock connection. Pass this object to `bootMachine()` as a plugin,
 * then use its capabilities after `bootMachine()` resolves.
 */
export interface GuestAgent extends MachinePluginProvider {
  readonly fs: FileSystem;
  /** Starts a process with streaming standard I/O. */
  readonly exec: Exec;
  /** Runs a process and collects its status, stdout, and stderr. */
  run(argv: readonly string[], options?: ExecOptions): Promise<RunResult>;
  readonly mount: MountCall;
  readonly unmount: Unmount;
  /**
   * The guest device node of the block device with this serial, such as
   * `/dev/vdb`. The mount table's disks have the serials `m0`, `m1`, and so
   * on, after their index in `mounts`. The serial must match exactly, spaces
   * included. Needs sysfs at `/sys`. Rejects with a `SystemError` whose code
   * is `"ENODEV"` if no disk has the serial, and with an `Error` if more than
   * one does.
   */
  disk(serial: string): Promise<string>;
}

/**
 * The guest agent while it boots: the same calls as a booted agent, plus the
 * step that makes `/sysroot` the root.
 */
export interface GuestBoot extends GuestAgent {
  /**
   * Makes `/sysroot` the root, as `switch_root` does. `/sysroot` must be a
   * mount point, and `/sysroot/dev`, `/sysroot/proc`, and `/sysroot/sys` must
   * have filesystems mounted on them, normally by moving `/dev`, `/proc`, and
   * `/sys` there. This deletes the initramfs's files, ends every process the
   * boot started, and has the agent enter the new root, then start `init` if
   * the agent was given one. Calls made after it resolves run in the new
   * root. The agent switches root once per boot.
   */
  switchRoot(): Promise<void>;
}

/** Options for {@link guestAgent}. */
export interface GuestAgentOptions {
  /**
   * The mount table for the default boot. Each entry with a source becomes a
   * device: a block device with the serial `m<i>`, or a virtio-fs device with
   * the tag `m<i>`, where `i` is its index here. The boot mounts the entry at
   * `/` first and then the others in order, beneath `/sysroot`, then makes
   * `/sysroot` the root. At most one entry can be at `/`. Without one, the
   * agent stays on its initramfs and mounts the others there. Each path is
   * resolved with the root as `/`, so symlinks in an image never lead out of
   * it, and missing directories are created. If a step fails, the boot
   * unmounts what it mounted, or remounts it read-only, before rejecting.
   */
  mounts?: readonly Mount[];
  /**
   * Replaces the default boot. The machine has booted the agent from its
   * initramfs, with devtmpfs on `/dev` and nothing else mounted. `boot` makes
   * whatever calls it needs and resolves when the guest is ready. The
   * devices of `mounts` are still attached.
   */
  boot?: (guest: GuestBoot) => Promise<void>;
  /**
   * A program for the agent to start in the new root, like the kernel starts
   * `/init`. Its exit powers the machine off, after the agent has stopped
   * every process and unmounted the filesystems. Needs a mount at `/` or a
   * `boot` that calls `switchRoot()`.
   */
  init?: readonly string[];
  /**
   * How long `machine.close()` waits for the guest to sync its filesystems
   * before forcing teardown. Defaults to 30 000 ms.
   */
  syncTimeoutMs?: number;
}

/**
 * A step of the guest's boot failed. `cause` is the step's error, usually a
 * `SystemError`, and `kernelLog` is the end of the kernel log at the time,
 * which often says why in the kernel's own words.
 */
export class GuestBootError extends Error {
  /** The step that failed, such as `mounting m0 (app.ext4) at /`. */
  readonly step: string;
  /** The last lines of the guest kernel's log, or empty if it was unreachable. */
  readonly kernelLog: string;

  constructor(step: string, options: { cause: unknown; detail?: string; kernelLog?: string }) {
    const reason = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`${step}: ${reason}${options.detail ? ` (${options.detail})` : ""}`, {
      cause: options.cause,
    });
    this.name = "GuestBootError";
    this.step = step;
    this.kernelLog = options.kernelLog ?? "";
  }
}

const readiness = new WeakMap<GuestAgent, (machine: Machine) => Promise<void>>();
const machines_with_agent = new WeakSet<MachineSetup>();

/** @internal Dependency hook for guest integrations whose booted work requires the agent. */
export function wait_for_agent(agent: GuestAgent, machine: Machine): Promise<void> {
  const wait = readiness.get(agent);
  if (!wait) throw new TypeError("guest agent was not created by guestAgent()");
  return wait(machine);
}

const MODES = ["rw", "ro", "overlay"] as const;

const INIT_ENVIRONMENT = [
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "HOME=/",
  "TERM=linux",
];

function normalized_path(path: string) {
  return (
    path === "/" ||
    (path.startsWith("/") &&
      path
        .slice(1)
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."))
  );
}

function is_filesystem(source: MountSource): source is FS<object, any> {
  return (
    typeof source === "object" &&
    "root" in source &&
    typeof (source as Partial<FS<object, any>>).lookup === "function"
  );
}

function check_mounts(mounts: readonly Mount[]) {
  let root: Mount | undefined;
  for (const mount of mounts) {
    if (typeof mount.path !== "string" || !normalized_path(mount.path)) {
      throw new TypeError(`mount paths must be absolute and normalized: ${mount.path}`);
    }
    if (mount.path === "/") {
      if (root) throw new TypeError("only one mount can be at /");
      root = mount;
    }
    if (mount.mode !== undefined && !MODES.includes(mount.mode)) {
      throw new TypeError(`mount mode must be "rw", "ro", or "overlay", got ${mount.mode}`);
    }
    if (mount.source === undefined && !mount.type) {
      throw new TypeError(`the mount at ${mount.path} needs a source or a type`);
    }
  }
  return root;
}

/** How a step names a mount source: what the caller gave, where that is short. */
function describe_source(source: MountSource): string {
  if (typeof source === "string") return source;
  if (source instanceof URL) return source.protocol === "file:" ? source.pathname : source.href;
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
    return `${source.byteLength} bytes`;
  }
  if (source instanceof Response) return source.url || "a response";
  if (source instanceof Blob) return "a blob";
  if (is_filesystem(source)) return "a shared filesystem";
  return "capacity" in source ? "block storage" : "a file handle";
}

/** A failure to find a filesystem type for a disk, with every type's error. */
class TypeProbeError extends Error {
  readonly attempts: readonly (readonly [string, SystemError])[];

  constructor(attempts: readonly (readonly [string, SystemError])[]) {
    // EINVAL means "not this filesystem", so any other error is the one that
    // explains the failure, such as EROFS from ext4 on read-only storage.
    const explaining = attempts.find(([, error]) => error.code !== "EINVAL") ?? attempts.at(-1);
    super(explaining ? explaining[1].message : "no filesystem type supports block devices", {
      cause: explaining?.[1],
    });
    this.attempts = attempts;
  }
}

/** Runs one boot step, turning its failure into a {@link GuestBootError}. */
async function step<T>(
  client: GuestClientCapabilities,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GuestBootError) throw error;
    const kernelLog = await kernel_log_tail(client);
    if (error instanceof TypeProbeError) {
      const tried = error.attempts.map(([type, failure]) => `${type}: ${failure.code}`);
      throw new GuestBootError(name, {
        cause: error.cause ?? error,
        detail: tried.length ? `tried ${tried.join(", ")}` : undefined,
        kernelLog,
      });
    }
    throw new GuestBootError(name, { cause: error, kernelLog });
  }
}

/** The last lines of the kernel log, or nothing if the guest cannot say. */
async function kernel_log_tail(client: GuestClientCapabilities): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const log = await Promise.race([
      client.kernel_log(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), 1000);
      }),
    ]);
    // The first line may be cut off, and each record starts with its level.
    return log
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .slice(-20)
      .map((line) => line.replace(/^<\d+>/, ""))
      .join("\n");
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function make_directory(guest: GuestAgent, path: string) {
  let prefix = "";
  for (const part of path.split("/").filter(Boolean)) {
    prefix += `/${part}`;
    try {
      await guest.fs.mkdir(prefix, { mode: 0o755 });
    } catch (error) {
      if (!(error instanceof SystemError && error.code === "EEXIST")) throw error;
    }
  }
}

/** Every block device that has a serial, by serial. */
/**
 * Every block device that has a serial, by serial. A serial is compared
 * exactly: virtio-blk's sysfs attribute is the ID up to its first NUL, with
 * no newline, and printable spaces are part of it.
 */
async function find_disks(guest: GuestAgent): Promise<Map<string, string[]>> {
  const disks = new Map<string, string[]>();
  for await (const entry of guest.fs.readDir("/sys/block")) {
    let serial: string;
    try {
      serial = await guest.fs.readTextFile(`/sys/block/${entry.name}/serial`);
    } catch (error) {
      // Only virtio block devices have a serial.
      if (error instanceof SystemError && error.code === "ENOENT") continue;
      throw error;
    }
    if (serial) disks.set(serial, [...(disks.get(serial) ?? []), `/dev/${entry.name}`]);
  }
  return disks;
}

/** The one device with `serial` among `disks`. */
function disk_with_serial(disks: Map<string, string[]>, serial: string): string {
  const devices = disks.get(serial) ?? [];
  if (devices.length > 1) {
    throw new Error(
      `more than one disk has the serial ${JSON.stringify(serial)}: ${devices.join(", ")}`,
    );
  }
  if (!devices[0]) throw new SystemError(E.NODEV);
  return devices[0];
}

/** The filesystems the guest kernel can mount from a block device, as BusyBox `mount` reads them. */
async function block_filesystems(guest: GuestAgent): Promise<string[]> {
  const table = await guest.fs.readTextFile("/proc/filesystems");
  return table
    .split("\n")
    .filter((line) => line && !line.startsWith("nodev"))
    .map((line) => line.trim());
}

/**
 * One mount the default boot made, in the order it made them: a mount at
 * `path`, or the mount it moved from `from` to `path`.
 */
interface MountRecord {
  readonly path: string;
  readonly from?: string;
}

/**
 * Mounts on the directory `path` names beneath `root`, resolved with `root`
 * as `/`, so a symlink in an image never sends a mount outside it. Records
 * where the mount went, as a path, for {@link unwind_mounts}; `from` marks a
 * move.
 */
async function mount_in(
  guest: GuestAgent,
  client: GuestClientCapabilities,
  mounted: MountRecord[],
  root: string,
  path: string,
  mount: (target: string) => Promise<void>,
  from?: string,
) {
  const directory = await client.open_directory_in(root, path);
  try {
    const target = `/proc/self/fd/${directory.fd}`;
    const where = await guest.fs.readLink(target);
    await mount(target);
    mounted.push(from === undefined ? { path: where } : { path: where, from });
  } finally {
    await directory.close();
  }
}

/**
 * Leaves storage the failed boot mounted clean: undoes its mounts in
 * reverse, unmounting each, or remounting it read-only if it stays busy, then
 * syncs. A writable ext4 left mounted would need journal recovery before it
 * could be mounted read-only. A move is undone by moving the mount back, so
 * the paths recorded before it name their mounts again: a moved /dev hides
 * whatever the table mounted beneath /sysroot/dev. /proc moved last, so it
 * comes back first. A move that cannot be undone is detached instead. Bounded, because it only tidies up after an error that is
 * reported anyway.
 */
async function unwind_mounts(guest: GuestAgent, mounted: readonly MountRecord[]) {
  const unwind = async () => {
    for (const { path, from } of mounted.toReversed()) {
      if (from !== undefined) {
        // switchRoot() may have deleted the initramfs's empty directory.
        await make_directory(guest, from).catch(() => {});
        try {
          await guest.mount(path, from, { flags: MountFlags.MOVE });
        } catch {
          // Still covering what the table mounted beneath it: detach it
          // lazily instead, so those mounts are reachable again.
          await guest.unmount(path, { flags: UnmountFlags.DETACH }).catch(() => {});
        }
        continue;
      }
      try {
        await guest.unmount(path);
      } catch {
        await guest
          .mount(null, path, { flags: MountFlags.REMOUNT | MountFlags.RDONLY })
          .catch(() => {});
      }
    }
    await guest.fs.sync().catch(() => {});
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    unwind().catch(() => {}),
    new Promise((resolve) => (timer = setTimeout(resolve, 5000))),
  ]);
  clearTimeout(timer);
}

/** The default boot: realize the mount table, then switch root if it has one. */
async function boot_mount_table(
  guest: GuestBoot,
  client: GuestClientCapabilities,
  mounts: readonly Mount[],
  mounted: MountRecord[],
) {
  await step(client, "mounting /proc, /sys and /dev/pts", async () => {
    await make_directory(guest, "/proc");
    await guest.mount("proc", "/proc", { type: "proc" });
    await make_directory(guest, "/sys");
    await guest.mount("sysfs", "/sys", { type: "sysfs" });
    await make_directory(guest, "/dev/pts");
    await guest.mount("devpts", "/dev/pts", { type: "devpts" });
  });

  const has_disks = mounts.some(
    (mount) => mount.source !== undefined && !is_filesystem(mount.source),
  );
  const disks = has_disks
    ? await step(client, "finding the disks", () => find_disks(guest))
    : new Map<string, string[]>();
  let filesystems: Promise<string[]> | undefined;

  const root = mounts.find((mount) => mount.path === "/");
  const prefix = root ? "/sysroot" : "";
  const table = mounts.map((mount, index) => ({ mount, index }));
  // The root goes first, so nothing it would cover is mounted before it.
  table.sort((a, b) => Number(b.mount.path === "/") - Number(a.mount.path === "/"));
  for (const { mount, index } of table) {
    const source = mount.source;
    const name = source === undefined ? mount.type! : `m${index} (${describe_source(source)})`;
    await step(client, `mounting ${name} at ${mount.path}`, async () => {
      let device: string;
      let type = mount.type;
      if (source === undefined) {
        device = mount.type!;
      } else if (is_filesystem(source)) {
        device = `m${index}`;
        type ??= "virtiofs";
      } else {
        device = disk_with_serial(disks, `m${index}`);
      }
      const mode = mount.mode ?? "rw";
      const options = mount.options;

      const attempt = async (at: string, flags: number) => {
        if (type) return guest.mount(device, at, { type, flags, data: options });
        filesystems ??= block_filesystems(guest);
        const attempts: [string, SystemError][] = [];
        for (const candidate of await filesystems) {
          try {
            await guest.mount(device, at, { type: candidate, flags, data: options });
            return;
          } catch (error) {
            if (!(error instanceof SystemError)) throw error;
            attempts.push([candidate, error]);
          }
        }
        throw new TypeProbeError(attempts);
      };

      // The root mounts on /sysroot itself. Everything else is a path in
      // the root, or in the initramfs without one.
      const place = (mount_at: (target: string) => Promise<void>) =>
        mount.path === "/"
          ? make_directory(guest, "/sysroot")
              .then(() => mount_at("/sysroot"))
              .then(() => void mounted.push({ path: "/sysroot" }))
          : mount_in(guest, client, mounted, prefix || "/", mount.path, mount_at);

      if (mode !== "overlay") {
        await place((target) => attempt(target, mode === "ro" ? MountFlags.RDONLY : 0));
        return;
      }
      // The layers live in the initramfs, beneath the root to be.
      const layers = `/run/lowland/m${index}`;
      await make_directory(guest, `${layers}/lower`);
      await attempt(`${layers}/lower`, MountFlags.RDONLY);
      mounted.push({ path: `${layers}/lower` });
      await make_directory(guest, `${layers}/rw`);
      await guest.mount("tmpfs", `${layers}/rw`, { type: "tmpfs", data: "mode=0755" });
      mounted.push({ path: `${layers}/rw` });
      await make_directory(guest, `${layers}/rw/upper`);
      await make_directory(guest, `${layers}/rw/work`);
      await place((target) =>
        guest.mount("overlay", target, {
          type: "overlay",
          data: `lowerdir=${layers}/lower,upperdir=${layers}/rw/upper,workdir=${layers}/rw/work`,
        }),
      );
    });
  }
  if (!root) return;

  await step(client, "moving /dev, /proc and /sys into /sysroot", async () => {
    // /proc goes last: the others name their targets through it.
    for (const name of ["dev", "sys", "proc"]) {
      await mount_in(
        guest,
        client,
        mounted,
        "/sysroot",
        name,
        (target) => guest.mount(`/${name}`, target, { flags: MountFlags.MOVE }),
        `/${name}`,
      );
    }
  });
  await guest.switchRoot();
}

/**
 * Deletes the initramfs's files, as `switch_root` does, but never crosses
 * into another filesystem: `/sysroot`, and anything mounted beneath the
 * initramfs, stay.
 */
async function delete_initramfs(guest: GuestAgent) {
  const initramfs = (await guest.fs.lstat("/")).dev;
  const remove = async (path: string): Promise<boolean> => {
    const info = await guest.fs.lstat(path);
    if (info.dev !== initramfs) return false;
    if (info.isDirectory) {
      const names: string[] = [];
      for await (const entry of guest.fs.readDir(path)) names.push(entry.name);
      let empty = true;
      for (const name of names) empty = (await remove(`${path}/${name}`)) && empty;
      if (!empty) return false;
    }
    await guest.fs.remove(path);
    return true;
  };
  const names: string[] = [];
  for await (const entry of guest.fs.readDir("/")) names.push(entry.name);
  for (const name of names) if (name !== "sysroot") await remove(`/${name}`);
}

/**
 * Creates a one-machine guest-agent integration. The plugin contributes the
 * agent as an initramfs, its vsock transport, and a device for each source
 * in `options.mounts`. Once the kernel has started the agent, the plugin
 * boots the guest: by default it realizes the mount table and makes its `/`
 * the root, or it runs `options.boot`. `bootMachine()` resolves once the
 * guest has booted. A failed step rejects with a {@link GuestBootError}.
 *
 * `machine.close()` first syncs the guest's filesystems through a ready
 * agent, waiting at most `syncTimeoutMs`; if that fails, teardown is forced
 * and `machine.closed` rejects. Closing before the agent is ready skips the
 * sync.
 *
 * @example Boot the canonical image beneath a writable overlay
 * ```ts
 * const guest = guestAgent({ mounts: [rootImage()] });
 * await using machine = await bootMachine({ cpus: 1, plugins: [guest] });
 * ```
 *
 * @example Boot a writable ext4 root with a host directory at /src
 * ```ts
 * const guest = guestAgent({
 *   mounts: [
 *     { path: "/", source: "root.ext4", type: "ext4" },
 *     { path: "/src", source: new NodeFS("./src") },
 *   ],
 * });
 * ```
 */
export function guestAgent(options: GuestAgentOptions = {}): GuestAgent {
  const mounts = [...(options.mounts ?? [])];
  const root = check_mounts(mounts);
  const init = options.init && [...options.init];
  if (init) {
    if (!init.length || init.some((arg) => typeof arg !== "string")) {
      throw new TypeError("init must be a nonempty array of strings");
    }
    if (!root && !options.boot) {
      throw new TypeError("init needs a mount at / or a boot that calls switchRoot()");
    }
  }
  const sync_timeout = options.syncTimeoutMs ?? 30_000;
  const vsock = vsockDevice();
  const client = create_guest_client(vsock);
  let configured = false;
  let attached_machine: Machine | undefined;
  let ready: Promise<void> | undefined;
  let is_ready = false;

  const boot = async (machine: Machine) => {
    await wait_for_guest(client, machine);
    let switched = false;
    const guest: GuestBoot = {
      ...agent,
      async switchRoot() {
        if (switched) throw new Error("the guest has already switched root");
        const sysroot = await step(client, "switching root", () => agent.fs.stat("/sysroot"));
        await step(client, "deleting the initramfs", () => delete_initramfs(agent));
        await step(client, "switching root", () =>
          client.switch_root(init && { argv: init, env: INIT_ENVIRONMENT }),
        );
        switched = true;
        try {
          await wait_for_guest(client, machine);
        } catch (error) {
          // PID 1 cannot reply once the session is over, so when it cannot
          // enter the new root or start init, it says why on its console and
          // powers off.
          throw new GuestBootError("switching root", {
            cause: error,
            detail: "the agent reports why on the machine's console",
          });
        }
        const root = await agent.fs.stat("/");
        if (root.dev !== sysroot.dev || root.ino !== sysroot.ino) {
          throw new GuestBootError("switching root", {
            cause: new Error("the new session's root is not /sysroot"),
          });
        }
      },
    };
    // What the default boot mounted, so a failure can leave it clean.
    const mounted: MountRecord[] = [];
    try {
      if (options.boot) await options.boot(guest);
      else await boot_mount_table(guest, client, mounts, mounted);
    } catch (error) {
      // Once PID 1 has switched root, its shutdown owns the mounts.
      if (!switched) await unwind_mounts(agent, mounted);
      throw error;
    }
    if (init && !switched) {
      throw new GuestBootError("starting init", {
        cause: new Error("the boot did not call switchRoot()"),
      });
    }
  };

  const wait = (machine: Machine) => {
    if (!configured)
      return Promise.reject(new Error("guest agent is not attached to this machine"));
    if (attached_machine && attached_machine !== machine) {
      return Promise.reject(new Error("guest agent is attached to a different machine"));
    }
    attached_machine = machine;
    return (ready ??= boot(machine).then(() => {
      is_ready = true;
    }));
  };

  const plugin: MachinePlugin = {
    async configure(setup) {
      if (configured) throw new Error("guest agent is already attached to a machine");
      if (machines_with_agent.has(setup)) {
        throw new Error("a machine supports one guest agent");
      }
      configured = true;
      machines_with_agent.add(setup);

      setup.devices.add(vsock);
      setup.initramfs.add(load_agent_initramfs());
      for (const [index, mount] of mounts.entries()) {
        const source = mount.source;
        if (source === undefined) continue;
        if (is_filesystem(source)) {
          setup.devices.add(fileSystemDevice(source, { tag: `m${index}` }));
          continue;
        }
        const storage = await diskStorage(source, { writable: (mount.mode ?? "rw") === "rw" });
        try {
          setup.devices.add(blockDevice(storage, { serial: `m${index}` }));
        } catch (error) {
          // The device never reached the machine, so nothing else will close
          // storage opened here.
          await storage.close?.();
          throw error;
        }
      }
    },
    async booted(machine) {
      await wait(machine);
    },
    async closing() {
      // Readiness has its own deadline; waiting for it here would leave close
      // unbounded, and an agent that never answered has written nothing.
      if (is_ready) await sync_before_close(client, sync_timeout);
    },
  };

  const agent: GuestAgent = {
    fs: client.fs,
    exec: client.exec,
    mount: client.mount,
    unmount: client.unmount,
    async run(argv, options) {
      const child: ChildProcess = await client.exec(argv, options);
      const [status, stdout, stderr] = await Promise.all([
        child.status,
        collect(child.stdout),
        collect(child.stderr),
        child.stdin.close(),
      ]);
      return { status, stdout, stderr };
    },
    async disk(serial) {
      return disk_with_serial(await find_disks(agent), serial);
    },
    [machinePlugin]() {
      return plugin;
    },
  };
  readiness.set(agent, wait);
  return agent;
}
