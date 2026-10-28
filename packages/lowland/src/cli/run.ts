// SPDX-License-Identifier: MIT

import { SystemError, type ChildProcess, exitCode, type TerminalSize } from "../guest/index.ts";
import { rootImage } from "../image/index.ts";
import type { Mount } from "../guest/index.ts";
import { createNetwork, type Network } from "../machine/index.ts";
import { NodeFS, nodeNetwork } from "../node/index.ts";
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { parseArgs } from "node:util";
import { Linux, type LinuxOptions } from "../linux.ts";
import { EXIT_FAILURE, UsageError } from "./usage.ts";

export const runUsage = `Usage: lowland run [options] [--] [command...]

Run a command in a fresh Linux machine. With no command, start a shell, on a
terminal when stdin is one.

Options:
  -v, --volume <src:dst[:mode]>  Mount a host directory or disk image (repeatable)
      --image <path>             Boot this root image instead of the canonical one
  -w, --workdir <dir>            Set the command working directory (default: /)
  -e, --env <name[=value]>       Set an environment variable, or pass one through (repeatable)
      --cpus <count>             Boot this many virtual CPUs (default: 1)
      --network <none|nat>       Give the machine a network (default: none)
  -t, --tty                      Run the command on a terminal; stdin must be one
  -h, --help                     Show help

A volume's source is a host directory, which is shared into the machine, or
a disk image file, which is attached as a disk. Its mode is rw (the default),
ro, or O, an overlay: the guest can write to it, but its writes last only as
long as the machine and the source never changes. A volume at / replaces the
root image. --image <path> is -v <path>:/:O, so the root image is never
modified. The machine has a tmpfs at /run and /tmp unless a volume is there.

With --network nat, the guest has egress through the host's sockets: its TCP
connections and DNS lookups go out as lowland's own, and 192.0.2.1 reaches
the host's loopback. With none, the machine has no network card.

When stdin is a terminal and no command is given, or with --tty, the command
runs on a guest terminal the size of the host's, with job control, and keys
such as Ctrl-C and Ctrl-Z go to it rather than to lowland. Otherwise its
standard I/O are pipes.

The command's exit status becomes lowland's. lowland itself exits 125 when it
fails, such as for an argument error or when the machine cannot run, 126 when
the command cannot be executed, and 127 when it is not found. A command
killed by a signal exits 128 plus the signal number.
`;

/** Options that take a value, so the first other word starts the command. */
const VALUE_OPTIONS = new Set([
  "--volume",
  "-v",
  "--image",
  "--workdir",
  "-w",
  "--env",
  "-e",
  "--cpus",
  "--network",
]);

const NETWORKS = ["none", "nat"] as const;

const MODES = { rw: "rw", ro: "ro", O: "overlay" } as const;

/** A `--volume` value: a host path, where it goes in the guest, and how. */
export interface Volume {
  source: string;
  path: string;
  mode: Mount["mode"] & {};
}

/** Splits `src:dst[:mode]`, where the source may itself contain colons. */
function parse_volume(value: string): Volume {
  const parts = value.split(":");
  const last = parts.at(-1)!;
  const mode =
    parts.length >= 3 && Object.hasOwn(MODES, last) ? MODES[last as keyof typeof MODES] : undefined;
  if (mode) parts.pop();
  const path = parts.pop();
  const source = parts.join(":");
  if (!source || !path?.startsWith("/")) {
    throw new UsageError(`--volume expects src:/dst[:ro|:rw|:O], got ${value}`);
  }
  return { source, path, mode: mode ?? "rw" };
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
  volumes: Volume[];
  cpus?: number;
  network: (typeof NETWORKS)[number];
  command: string[];
  cwd: string;
  env: Record<string, string>;
  /** `-t`: run the command on a terminal even when one is given. */
  tty: boolean;
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
        volume: { type: "string", short: "v", multiple: true, default: [] },
        image: { type: "string" },
        workdir: { type: "string", short: "w", default: "/" },
        env: { type: "string", short: "e", multiple: true, default: [] },
        cpus: { type: "string" },
        network: { type: "string", default: "none" },
        tty: { type: "boolean", short: "t", default: false },
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
  const volumes = values.volume.map(parse_volume);
  if (values.image !== undefined) {
    if (!values.image) throw new UsageError("--image expects a path");
    volumes.unshift({ source: values.image, path: "/", mode: "overlay" });
  }
  const paths = new Set<string>();
  for (const { path } of volumes) {
    if (paths.has(path)) {
      throw new UsageError(
        path === "/" ? "--image and a volume at / both replace the root" : `two volumes at ${path}`,
      );
    }
    paths.add(path);
  }
  return {
    volumes,
    cpus: values.cpus === undefined ? undefined : Number(values.cpus),
    network,
    command,
    cwd: values.workdir,
    env,
    tty: values.tty,
  };
}

/**
 * The `Linux` options for parsed arguments. A directory becomes a share and
 * anything else a disk, so the sources are checked here, where a failure
 * stops lowland rather than surfacing later in the guest.
 */
export async function machineOptions(run: RunArguments, network?: Network): Promise<LinuxOptions> {
  const mounts = await Promise.all(
    run.volumes.map(async ({ source, path, mode }): Promise<Mount> => {
      const info = await stat(source).catch(() => undefined);
      if (!info) throw new Error(`${source} does not exist`);
      // Opening a FIFO blocks, and a device is no disk image.
      if (!info.isDirectory() && !info.isFile()) {
        throw new Error(`${source} is neither a directory nor a regular file`);
      }
      if (info.isDirectory()) {
        return { path, source: new NodeFS(source, { readOnly: mode !== "rw" }), mode };
      }
      // rootImage() checks that a root image is one and knows its type.
      return path === "/" ? { ...rootImage(source), mode } : { path, source, mode };
    }),
  );
  const root = mounts.findIndex(({ path }) => path === "/");
  return {
    // The command line is not bundled into applications, so it can default
    // to the canonical image.
    image: root === -1 ? rootImage() : mounts.splice(root, 1)[0]!,
    mounts,
    cpus: run.cpus,
    network,
  };
}

/** The host terminal a guest terminal follows. */
export interface HostTerminal {
  /** The terminal's input, put in raw mode while the command runs. */
  input: ReadStream;
  /** The terminal's display, whose size the guest terminal takes. */
  output?: WriteStream;
}

/** The host's terminal, if stdin is one. */
function host_terminal(): HostTerminal | undefined {
  if (!process.stdin.isTTY) return undefined;
  // The size of a terminal is read from its display, which may be stderr
  // when stdout is redirected.
  const output = [process.stdout, process.stderr].find((stream) => stream.isTTY);
  return { input: process.stdin, output };
}

/**
 * Turns off the host terminal's output processing, which Node's raw mode
 * leaves on. The guest terminal has processed the output already, so the
 * host's own ONLCR would turn each bare LF a full-screen program sends to
 * move the cursor down into CR LF. Leaving raw mode restores it along with
 * the other modes Node saved.
 */
function disable_output_processing(input: ReadStream) {
  // Node types a tty.ReadStream as a socket, without its descriptor.
  const { fd } = input as { fd?: unknown };
  if (process.platform === "win32" || typeof fd !== "number") return;
  const result = spawnSync("stty", ["-opost"], { stdio: [fd, "ignore", "pipe"] });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr.toString().trim() || "stty failed");
    throw new Error(`cannot turn off the terminal's output processing: ${reason}`);
  }
}

function window_size(terminal: HostTerminal): TerminalSize {
  const { rows = 24, columns = 80 } = terminal.output ?? {};
  return { rows, columns };
}

async function spawn(
  linux: Linux,
  run: RunArguments,
  argv: string[],
  terminal: HostTerminal | undefined,
) {
  try {
    if (!terminal) return await linux.spawn(argv, { cwd: run.cwd, env: run.env });
    // Like docker run -t, which sets TERM for a terminal it allocates.
    return await linux.spawn(argv, {
      cwd: run.cwd,
      env: { TERM: "xterm", ...run.env },
      terminal: window_size(terminal),
    });
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
 * `exited` settles. Resolves to whether the host reader went away, and
 * rejects only when the host stream fails for another reason, such as a full
 * disk.
 */
async function forward_output(
  source: ReadableStream<Uint8Array>,
  target: NodeJS.WriteStream,
  exited: Promise<unknown>,
): Promise<boolean> {
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
      if (result === IDLE || result.done) return false;
      try {
        await write_host(target, result.value);
      } catch (error) {
        // A host reader that went away is a broken pipe for the command too.
        if ((error as NodeJS.ErrnoException).code === "EPIPE") return true;
        throw error;
      }
    }
  } finally {
    // Closing the guest's end gives a writer that is still running EPIPE.
    void reader.cancel().catch(() => {});
  }
}

/**
 * Connects the host's standard I/O to a guest process and waits for it. A
 * process on a guest terminal gets the host terminal, which is in raw mode
 * until the process exits, so keys like Ctrl-C reach the guest's line
 * discipline instead of signalling lowland.
 */
async function attach(child: ChildProcess, terminal: HostTerminal | undefined) {
  // On a terminal, a hangup of the host's goes to the guest's too, and its
  // session leader decides what to do, as with the other signals.
  const signals = terminal
    ? (["SIGINT", "SIGTERM", "SIGHUP"] as const)
    : (["SIGINT", "SIGTERM"] as const);
  // Not once the command has been reaped: its pid may belong to another
  // process by then, while a descendant still holds the output open.
  let reaped = false;
  void child.status.then(
    () => (reaped = true),
    () => (reaped = true),
  );
  const forwards = signals.map(
    (signal) =>
      [signal, () => void (reaped ? undefined : child.kill(signal).catch(() => {}))] as const,
  );
  const on_resize = () => void child.resize(window_size(terminal!)).catch(() => {});
  const input = terminal?.input ?? process.stdin;
  // stdin stops being read once the process exits, even if it never ends.
  // The pipe is aborted without cancelling its source: destroying
  // process.stdin would close descriptor 0, which the next file opened
  // during cleanup would then reuse. It is never awaited, because a write
  // to an exited command can stay pending until the machine shuts down.
  const stop_input = new AbortController();
  let raw = false;
  try {
    for (const [signal, forward] of forwards) process.on(signal, forward);
    terminal?.output?.on("resize", on_resize);
    if (terminal) {
      terminal.input.setRawMode(true);
      raw = true;
      disable_output_processing(terminal.input);
      // The window may have changed size since the terminal was created.
      on_resize();
    }

    const stdin = Readable.toWeb(input) as ReadableStream<Uint8Array>;
    void stdin
      .pipeTo(child.stdin, { signal: stop_input.signal, preventCancel: true })
      .catch(() => {});

    // A terminal's stderr is empty: its output, standard error included, is
    // all on stdout.
    const output = Promise.all([
      forward_output(child.stdout, process.stdout, child.status).then((broken) => {
        // A pipe passes a reader that went away on to the writer as EPIPE,
        // but a terminal stays open for its input, so its writer would block
        // instead. Hang it up, as closing a terminal emulator would.
        if (broken && terminal) void child[Symbol.asyncDispose]().catch(() => {});
      }),
      terminal ? undefined : forward_output(child.stderr, process.stderr, child.status),
    ]);
    // Output that cannot be delivered ends the run, so the command must not
    // keep it waiting.
    output.catch(() => void child.kill("SIGKILL").catch(() => {}));
    const [status] = await Promise.all([child.status, output]);
    return exitCode(status);
  } finally {
    // Before anything else, so lowland's own messages, and whatever runs
    // after it, find the terminal as it was.
    if (raw) terminal!.input.setRawMode(false);
    terminal?.output?.off("resize", on_resize);
    for (const [signal, forward] of forwards) process.off(signal, forward);
    stop_input.abort();
    input.pause();
  }
}

function report(error: unknown) {
  process.stderr.write(`lowland run: ${error instanceof Error ? error.message : error}\n`);
}

/** How long the guest has to shut down once the command has finished. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** How `execute()` runs a command. */
export interface ExecuteOptions {
  /** Runs the command on a guest terminal attached to this host terminal. */
  terminal?: HostTerminal;
  /** Creates the machine. Defaults to `Linux.create`. */
  create?: (options: LinuxOptions) => Promise<Linux>;
}

/**
 * Runs a parsed command in a machine and returns the exit status. Every
 * failure of lowland or the machine, disposal included, exits 125.
 */
export async function execute(
  parsed: RunArguments,
  argv: string[],
  { terminal, create = Linux.create }: ExecuteOptions = {},
): Promise<number> {
  const network = parsed.network === "nat" ? createNetwork(nodeNetwork()) : undefined;
  let spawning = true;
  let pending: "SIGINT" | "SIGTERM" | "SIGHUP" | undefined;
  try {
    let linux: Linux;
    try {
      linux = await create(await machineOptions(parsed, network));
    } catch (error) {
      report(error);
      return EXIT_FAILURE;
    }
    // A signal must not end lowland before the guest has shut down and
    // flushed its disks. One that arrives while the command starts is kept
    // for it. While the command runs, attach() forwards signals to it.
    // Afterwards they are ignored, and the shutdown timeout bounds the wait.
    const held = terminal
      ? (["SIGINT", "SIGTERM", "SIGHUP"] as const)
      : (["SIGINT", "SIGTERM"] as const);
    const holds = held.map(
      (signal) =>
        [
          signal,
          () => {
            if (spawning) pending ??= signal;
          },
        ] as const,
    );
    for (const [signal, hold] of holds) process.on(signal, hold);
    try {
      return await finish(linux);
    } finally {
      for (const [signal, hold] of holds) process.off(signal, hold);
    }
  } finally {
    network?.close();
  }

  async function finish(linux: Linux) {
    let code: number;
    try {
      const child = await spawn(linux, parsed, argv, terminal);
      spawning = false;
      if (typeof child !== "number" && pending) void child.kill(pending).catch(() => {});
      code = typeof child === "number" ? child : await attach(child, terminal);
    } catch (error) {
      report(error);
      code = EXIT_FAILURE;
    }
    // The guest ends its processes, then syncs and unmounts its disks.
    const exit = await linux.shutdown({ timeoutMs: SHUTDOWN_TIMEOUT_MS });
    if (exit.reason !== "poweroff") {
      report(
        exit.reason === "crash"
          ? exit.error
          : exit.reason === "kill"
            ? `the machine did not shut down within ${SHUTDOWN_TIMEOUT_MS / 1000} s, and was killed`
            : `the machine ended with ${exit.reason}`,
      );
      return EXIT_FAILURE;
    }
    return code;
  }
}

/**
 * The command `lowland run` starts when it is given none: a shell. On a
 * terminal it is interactive because its stdin is a terminal too.
 */
const SHELL = ["sh"];

/** Runs `lowland run` and returns the exit status. */
export async function run(args: string[]): Promise<number> {
  const parsed = parseRunArgs(args);
  if (!parsed) {
    process.stdout.write(runUsage);
    return 0;
  }
  const host = host_terminal();
  // Like docker run -it, a terminal needs one to read keys from.
  if (parsed.tty && !host) throw new Error("--tty needs stdin to be a terminal");
  const terminal = parsed.tty || !parsed.command.length ? host : undefined;
  const argv = parsed.command.length ? parsed.command : SHELL;
  capture_output_errors();
  return execute(parsed, argv, { terminal });
}
