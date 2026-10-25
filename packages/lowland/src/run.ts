// SPDX-License-Identifier: MIT

import {
  createNetwork,
  SystemError,
  type ChildProcess,
  type CommandStatus,
  type Network,
} from "@lowland/guest";
import { NodeFS } from "@lowland/guest/node";
import { resolve4 } from "node:dns/promises";
import { once } from "node:events";
import { open, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { Linux, type LinuxOptions } from "./linux.ts";
import { EXIT_FAILURE, UsageError } from "./usage.ts";

export const runUsage = `Usage: lowland run [options] [--] [command...]

Run a command in a fresh Linux machine. With no command, start a shell.

Options:
      --image <path>             Boot this root image instead of the canonical one
      --disk <path:guest[:ro]>   Attach a disk image and mount it (repeatable)
  -v, --mount <host:guest[:ro]>  Share a host directory into the machine (repeatable)
  -w, --cwd <path>               Set the command working directory (default: /)
  -e, --env <name[=value]>       Set an environment variable, or pass one through (repeatable)
      --cpus <count>             Boot this many virtual CPUs (default: 1)
      --network <none|host>      Connect the machine to the host's network (default: none)
  -h, --help                     Show help

The root image is never modified: changes to it last only as long as the
machine. Writes persist only to ext4 disks and shared directories.

The command's exit status becomes lowland's. lowland itself exits 125 when it
fails, such as for an argument error or when the machine cannot run, 126 when
the command cannot be executed, and 127 when it is not found. A command
killed by a signal exits 128 plus the signal number.
`;

/** Options that take a value, so the first other word starts the command. */
const VALUE_OPTIONS = new Set([
  "--image",
  "--disk",
  "--mount",
  "-v",
  "--cwd",
  "-w",
  "--env",
  "-e",
  "--cpus",
  "--network",
]);

const NETWORKS = ["none", "host"] as const;

const ROOT_LABEL = "LOWLAND_ROOT";

const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGTERM: 15,
};

/** A `--disk` or `--mount` value: a host path and where it goes in the guest. */
export interface Attachment {
  source: string;
  path: string;
  readOnly: boolean;
}

/** Splits `source:guest[:ro]`, where the source may itself contain colons. */
function parse_attachment(flag: string, value: string): Attachment {
  const parts = value.split(":");
  const readOnly = parts.length >= 3 && parts.at(-1) === "ro";
  if (readOnly) parts.pop();
  const path = parts.pop();
  const source = parts.join(":");
  if (!source || !path)
    throw new UsageError(
      `${flag} expects ${flag === "--disk" ? "path" : "host"}:guest[:ro], got ${value}`,
    );
  return { source, path, readOnly };
}

function parse_env(value: string, environment: NodeJS.ProcessEnv): [string, string] | undefined {
  const separator = value.indexOf("=");
  const name = separator === -1 ? value : value.slice(0, separator);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new UsageError(`--env expects name[=value], got ${value}`);
  }
  if (separator !== -1) return [name, value.slice(separator + 1)];
  // Like docker run -e NAME, a bare name passes the host's value through.
  const inherited = environment[name];
  return inherited === undefined ? undefined : [name, inherited];
}

/** The parsed form of `lowland run` arguments. */
export interface RunArguments {
  image?: string;
  disks: Attachment[];
  mounts: Attachment[];
  cpus?: number;
  network: (typeof NETWORKS)[number];
  command: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Parses `lowland run` arguments, or returns `undefined` for `--help`. */
export function parseRunArgs(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): RunArguments | undefined {
  // Options end at `--` or at the first word that is not an option, so
  // `lowland run ls -l` passes `-l` to ls.
  let end = 0;
  while (end < args.length) {
    const arg = args[end]!;
    if (arg === "--" || !arg.startsWith("-") || arg === "-") break;
    end += VALUE_OPTIONS.has(arg) ? 2 : 1;
  }
  end = Math.min(end, args.length);
  const command = args.slice(args[end] === "--" ? end + 1 : end);

  let parsed;
  try {
    parsed = parseArgs({
      args: args.slice(0, end),
      options: {
        image: { type: "string" },
        disk: { type: "string", multiple: true, default: [] },
        mount: { type: "string", short: "v", multiple: true, default: [] },
        cwd: { type: "string", short: "w", default: "/" },
        env: { type: "string", short: "e", multiple: true, default: [] },
        cpus: { type: "string" },
        network: { type: "string", default: "none" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values } = parsed;
  if (values.help) return undefined;
  if (values.cpus !== undefined && !/^[1-9][0-9]*$/.test(values.cpus)) {
    throw new UsageError(`--cpus expects a positive whole number, got ${values.cpus}`);
  }
  const network = values.network as RunArguments["network"];
  if (!NETWORKS.includes(network)) {
    throw new UsageError(`--network expects ${NETWORKS.join(" or ")}, got ${values.network}`);
  }
  const env = Object.fromEntries(
    values.env.flatMap((value) => {
      const entry = parse_env(value, environment);
      return entry ? [entry] : [];
    }),
  );
  return {
    image: values.image,
    disks: values.disk.map((value) => parse_attachment("--disk", value)),
    mounts: values.mount.map((value) => parse_attachment("--mount", value)),
    cpus: values.cpus === undefined ? undefined : Number(values.cpus),
    network,
    command,
    cwd: values.cwd,
    env,
  };
}

/**
 * Checks a disk image file before boot, so mistakes get a message about the
 * file rather than a failed boot.
 */
async function check_disk({ source, readOnly }: Attachment) {
  const handle = await open(source, "r");
  let header: Uint8Array;
  try {
    header = new Uint8Array(2048);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    header = header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const label = (offset: number) =>
    new TextDecoder().decode(header.subarray(offset, offset + 16)).replace(/\0.*$/s, "");
  let type: string | undefined;
  let name = "";
  if (header.byteLength >= 1104 && view.getUint32(1024, true) === 0xe0f5e1e2) {
    type = "erofs";
    name = label(1024 + 64);
  } else if (header.byteLength >= 1160 && view.getUint16(1024 + 56, true) === 0xef53) {
    type = "ext4";
    name = label(1024 + 120);
  }
  if (!type) throw new Error(`${source} contains neither an EROFS nor an ext4 filesystem`);
  // The guest agent would find two roots and refuse to boot.
  if (name === ROOT_LABEL) {
    throw new Error(
      `${source} is labeled ${ROOT_LABEL}, the root image label; relabel it to attach it as a disk`,
    );
  }
  if (type === "erofs" && !readOnly) {
    throw new Error(`${source} is an EROFS image, which can only be attached read-only (:ro)`);
  }
}

/**
 * @internal The bytes a socket receives, ending at the remote FIN while the
 * socket stays open for writing. Node's own `Duplex.toWeb()` waits for both
 * directions to close before Node 24.20 and 26.7.
 */
export function socket_readable(socket: Socket): ReadableStream<Uint8Array> {
  // Set once the stream is closed, errored, or cancelled, after which the
  // socket's remaining events must not touch it.
  let done = false;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          if (error) controller.error(error);
          else controller.close();
        };
        socket.on("data", (chunk: Buffer) => {
          if (done) return;
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          if ((controller.desiredSize ?? 0) <= 0) socket.pause();
        });
        socket.once("end", () => finish());
        socket.once("error", (error) => finish(error));
        socket.once("close", () => finish());
      },
      pull() {
        socket.resume();
      },
      cancel() {
        done = true;
        socket.destroy();
      },
    },
    { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
  );
}

/**
 * A network that reaches whatever the host can. Guest TCP connections and
 * DNS queries go out through the host's sockets and resolver, and the
 * gateway address reaches the host's loopback.
 */
function host_network(): Network {
  return createNetwork({
    async connectTcp(session) {
      session.signal.throwIfAborted();
      // Half-open, so a peer that finishes sending still gets the rest of
      // what the guest sends.
      const socket = createConnection({
        host: session.target.hostname,
        port: session.target.port,
        signal: session.signal,
        allowHalfOpen: true,
      });
      try {
        await once(socket, "connect");
        await Promise.all([
          session.readable.pipeTo(Writable.toWeb(socket) as WritableStream<Uint8Array>),
          socket_readable(socket).pipeTo(session.writable),
        ]);
      } finally {
        // An abort can win the race with the connection, which Node then
        // still establishes.
        socket.destroy();
      }
    },
    resolveDns: resolve4,
  });
}

/** The `Linux` options for parsed arguments, with host paths checked. */
export async function machineOptions(run: RunArguments, network?: Network): Promise<LinuxOptions> {
  await Promise.all(run.disks.map(check_disk));
  // NodeFS resolves its root lazily, so check the directories now, where a
  // failure stops lowland rather than surfacing later in the guest.
  await Promise.all(
    run.mounts.map(async ({ source }) => {
      const info = await stat(source).catch(() => undefined);
      if (!info?.isDirectory()) throw new Error(`${source} is not a directory`);
    }),
  );
  return {
    image: run.image,
    disks: run.disks,
    mounts: run.mounts.map(({ source, path, readOnly }) => ({
      source: new NodeFS(source, { readOnly }),
      path,
      readOnly,
    })),
    cpus: run.cpus,
    network,
  };
}

/** The exit status a shell would report for a guest command. */
export function exitCode(status: CommandStatus): number {
  if (status.signal === null) return status.code;
  const number = typeof status.signal === "number" ? status.signal : SIGNALS[status.signal];
  return 128 + (number ?? 0);
}

async function spawn(linux: Linux, run: RunArguments, argv: string[]) {
  try {
    return await linux.spawn(argv, { cwd: run.cwd, env: run.env });
  } catch (error) {
    // Like a shell: 127 when the command does not exist, and 126 when it
    // exists but cannot be executed.
    if (!(error instanceof SystemError)) throw error;
    const missing = error.code === "ENOENT";
    const reason = missing ? "command not found" : `cannot execute (${error.message})`;
    process.stderr.write(`lowland run: ${argv[0]}: ${reason}\n`);
    return missing ? 127 : 126;
  }
}

/**
 * Keeps `error` events on stdout and stderr, such as EPIPE when a reader like
 * `head` exits, from crashing the process. Each write reports its own error
 * through its callback. This runs before the machine boots: the kernel's
 * workers also listen on these streams, and adding a listener after them
 * trips Node's leak warning.
 */
function capture_output_errors() {
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
}

/** Writes a chunk to a Node stream, waiting until it is flushed or fails. */
function write_host(stream: NodeJS.WriteStream, chunk: Uint8Array) {
  return new Promise<void>((resolve, reject) =>
    stream.write(chunk, (error) => (error ? reject(error) : resolve())),
  );
}

/**
 * How long to wait for more output once the command has exited. Background
 * processes the command started can hold its stdout open indefinitely, as
 * they would keep a container's output open after its main process exits.
 * The wait applies only while no data arrives: everything the guest has
 * already written is delivered.
 */
const OUTPUT_GRACE_MS = 500;

const IDLE = Symbol("idle");

/**
 * Copies a guest stream to a host stream until it ends, until the host
 * reader goes away, or until it stays idle for OUTPUT_GRACE_MS after
 * `exited` settles. Rejects only when the host stream fails for another
 * reason, such as a full disk.
 */
async function forward_output(
  source: ReadableStream<Uint8Array>,
  target: NodeJS.WriteStream,
  exited: Promise<unknown>,
) {
  const reader = source.getReader();
  // Each read arms its own idle timer once the command has exited, so a busy
  // stream never accumulates timers or promise reactions.
  let has_exited = false;
  let on_exit: (() => void) | undefined;
  void exited.then(
    () => ((has_exited = true), on_exit?.()),
    () => ((has_exited = true), on_exit?.()),
  );
  const read = () =>
    new Promise<ReadableStreamReadResult<Uint8Array> | typeof IDLE>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const arm = () => {
        if (!settled) timer = setTimeout(resolve, OUTPUT_GRACE_MS, IDLE);
      };
      const settle = () => ((settled = true), clearTimeout(timer));
      reader.read().then(
        (result) => (settle(), resolve(result)),
        (error) => (settle(), reject(error)),
      );
      if (has_exited) arm();
      else on_exit = arm;
    }).finally(() => (on_exit = undefined));
  try {
    for (;;) {
      const result = await read();
      if (result === IDLE || result.done) return;
      try {
        await write_host(target, result.value);
      } catch (error) {
        // A host reader that went away is a broken pipe for the command too.
        if ((error as NodeJS.ErrnoException).code === "EPIPE") return;
        throw error;
      }
    }
  } finally {
    // Closing the guest's end gives a writer that is still running EPIPE.
    void reader.cancel().catch(() => {});
  }
}

/** Connects the host's standard I/O to a guest process and waits for it. */
async function attach(child: ChildProcess) {
  const forward = (signal: "SIGINT" | "SIGTERM") => () => void child.kill(signal).catch(() => {});
  const on_interrupt = forward("SIGINT");
  const on_terminate = forward("SIGTERM");
  process.on("SIGINT", on_interrupt);
  process.on("SIGTERM", on_terminate);

  // stdin stops being read once the process exits, even if it never ends.
  // The pipe is aborted without cancelling its source: destroying
  // process.stdin would close descriptor 0, which the next file opened
  // during cleanup would then reuse. It is never awaited, because a write
  // to an exited command can stay pending until the machine shuts down.
  const stop_input = new AbortController();
  const stdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  void stdin
    .pipeTo(child.stdin, { signal: stop_input.signal, preventCancel: true })
    .catch(() => {});

  const output = Promise.all([
    forward_output(child.stdout, process.stdout, child.status),
    forward_output(child.stderr, process.stderr, child.status),
  ]);
  // Output that cannot be delivered ends the run, so the command must not
  // keep it waiting.
  output.catch(() => void child.kill("SIGKILL").catch(() => {}));
  try {
    const [status] = await Promise.all([child.status, output]);
    return exitCode(status);
  } finally {
    process.off("SIGINT", on_interrupt);
    process.off("SIGTERM", on_terminate);
    stop_input.abort();
    process.stdin.pause();
  }
}

function report(error: unknown) {
  process.stderr.write(`lowland run: ${error instanceof Error ? error.message : error}\n`);
}

/**
 * Runs a parsed command in a machine from `create` and returns the exit
 * status. Every failure of lowland or the machine, disposal included, exits
 * 125.
 */
export async function execute(
  parsed: RunArguments,
  argv: string[],
  create: (options: LinuxOptions) => Promise<Linux> = Linux.create,
): Promise<number> {
  const network = parsed.network === "host" ? host_network() : undefined;
  try {
    let linux: Linux;
    try {
      linux = await create(await machineOptions(parsed, network));
    } catch (error) {
      report(error);
      return EXIT_FAILURE;
    }
    let code: number;
    try {
      const child = await spawn(linux, parsed, argv);
      code = typeof child === "number" ? child : await attach(child);
    } catch (error) {
      report(error);
      code = EXIT_FAILURE;
    }
    try {
      await linux[Symbol.asyncDispose]();
    } catch (error) {
      report(error);
      return EXIT_FAILURE;
    }
    return code;
  } finally {
    network?.close();
  }
}

/**
 * The command `lowland run` starts when it is given none: a shell,
 * interactive when stdin is a terminal.
 *
 * The guest has no PTY yet, so the shell runs over pipes like any command,
 * without job control or window resizing. This is the seam for a guest PTY:
 * once `@lowland/guest` can start a process on one, a terminal gets a shell
 * on a PTY from here, attached in raw mode rather than through `attach()`.
 */
export function shellCommand(terminal: boolean): string[] {
  return terminal ? ["sh", "-i"] : ["sh"];
}

/** Runs `lowland run` and returns the exit status. */
export async function run(args: string[]): Promise<number> {
  const parsed = parseRunArgs(args);
  if (!parsed) {
    process.stdout.write(runUsage);
    return 0;
  }
  const argv = parsed.command.length ? parsed.command : shellCommand(!!process.stdin.isTTY);
  capture_output_errors();
  return execute(parsed, argv);
}
