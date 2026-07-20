// The page's shared machine. Every demo on the landing page — the terminal,
// the runnable examples, the live facts table — addresses this one guest, so
// the module boots it once and hands out the same instance everywhere.
import {
  consoleDevice,
  createNetwork,
  entropyDevice,
  spawnGuest,
  type Guest,
  type Network,
  type NetworkedGuest,
  type SpawnGuestOptions,
} from "@tombl/linux-guest";
import * as Linux from "@tombl/linux";
import type { VirtioDevice } from "@tombl/linux";

export type FramebufferDevice = VirtioDevice & {
  readonly width: number;
  readonly height: number;
  readRgba(target?: Uint8ClampedArray): Uint8ClampedArray;
};

export type InputDevice = VirtioDevice & {
  enqueueKeyEvent(code: number, pressed: boolean): void;
  enqueueRelativeEvent(axis: number, value: number): void;
  enqueueButtonEvent(code: number, pressed: boolean): void;
  enqueueWheelEvent(delta: number): void;
};

const graphicalLinux = Linux as typeof Linux & {
  framebufferDevice?: (options: { width: number; height: number }) => FramebufferDevice;
  inputDevice?: (options: { kind: "keyboard" | "mouse" }) => InputDevice;
};

export const framebuffer = graphicalLinux.framebufferDevice?.({ width: 1024, height: 768 });
export const keyboard = graphicalLinux.inputDevice?.({ kind: "keyboard" });
export const mouse = graphicalLinux.inputDevice?.({ kind: "mouse" });

const graphicalDevices: VirtioDevice[] = [];
if (framebuffer) graphicalDevices.push(framebuffer);
if (keyboard) graphicalDevices.push(keyboard);
if (mouse) graphicalDevices.push(mouse);

export interface Hero {
  guest: NetworkedGuest;
  network: Network;
  bootMs: number;
  cpus: number;
  rootfsBytes: number;
}

async function fetchBytes(path: string) {
  let response = await fetch(path);
  if (!response.ok) throw new Error(`failed to fetch ${path}: ${response.status}`);
  if (path.endsWith(".gz") && response.headers.get("Content-Encoding") !== "gzip") {
    if (!response.body) throw new Error(`failed to read ${path}`);
    response = new Response(response.body.pipeThrough(new DecompressionStream("gzip")));
  }
  return new Uint8Array(await response.arrayBuffer());
}

// Console plumbing. The guest writes through as many streams as it likes
// (boot console, then the virtio console); a single listener — the xterm —
// renders them all. Writes wait for it to attach, then remain pending until the
// listener has consumed them so backpressure reaches the guest's virtqueue.
type ConsoleListener = (data: Uint8Array) => Promise<void>;
const consoleListener = Promise.withResolvers<ConsoleListener>();

function consoleSink() {
  return new WritableStream<Uint8Array>({
    async write(data) {
      const listener = await consoleListener.promise;
      return listener(data);
    },
  });
}

export function attachConsole(listener: ConsoleListener) {
  consoleListener.resolve(listener);
}

const encoder = new TextEncoder();
let inputController!: ReadableStreamDefaultController<Uint8Array>;
const consoleInput = new ReadableStream<Uint8Array>({
  start(controller) {
    inputController = controller;
  },
});

export function writeConsole(text: string) {
  inputController.enqueue(encoder.encode(text));
}

const terminalConsole = consoleDevice(consoleInput, consoleSink());

export function resizeConsole(columns: number, rows: number) {
  terminalConsole.resize(columns, rows);
}

// Neofetch-style banner: the machine introduces itself in its own ANSI
// colors, standing in for the logo we don't have.
const sgr = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;

interface BootFacts {
  cpus: number;
  bootMs: number;
  rootfsBytes: number;
}

function motd(kernel: string, { cpus, bootMs, rootfsBytes }: BootFacts) {
  // [plain, colored] pairs: the plain text measures the column, the colored
  // text is what prints.
  const tux: Array<[plain: string, colored: string]> = [
    ["    .--.", "    .--."],
    ["   |o_o |", "   |o_o |"],
    ["   |:_/ |", `   |${sgr("33", ":_/")} |`],
    ["  //   \\ \\", "  //   \\ \\"],
    [" (|     | )", " (|     | )"],
    ["/'\\_   _/`\\", `${sgr("33", "/'")}\\_   _/${sgr("33", "`\\")}`],
    ["\\___)=(___/", sgr("33", "\\___)=(___/")],
  ];

  const label = (text: string) => sgr("1;34", text.padEnd(10));
  const swatches = (base: number) =>
    Array.from({ length: 8 }, (_, i) => `\x1b[${base + i}m   `).join("") + "\x1b[0m";

  const title = "guest@lowland";
  const info = [
    sgr("1", title),
    sgr("90", "─".repeat(title.length)),
    `${label("kernel")}${kernel}`,
    `${label("cpus")}${cpus}`,
    `${label("boot")}${bootMs} ms`,
    `${label("rootfs")}${Math.round(rootfsBytes / 2 ** 20)} MiB squashfs`,
    `${label("console")}/dev/hvc0 → xterm.js`,
    "",
    swatches(40),
    swatches(100),
  ];

  const column = Math.max(...tux.map(([plain]) => plain.length)) + 3;
  const lines = [];
  for (let i = 0; i < Math.max(tux.length, info.length); i++) {
    const [plain, colored] = tux[i] ?? ["", ""];
    lines.push(`  ${colored}${" ".repeat(column - plain.length)}${info[i] ?? ""}`.trimEnd());
  }
  return `\n${lines.join("\n")}\n`;
}

// The guest agent is init and starts nothing on the console, so the
// interactive shell is just a process bound to the console tty — respawned
// if it exits. cttyhack gives it a controlling terminal (job control,
// Ctrl+C). Like a getty, each (re)spawn clears the boot log and prints the
// motd; it rides in through $MOTD so it prints after the clear, in order
// with the rest of the console stream.
async function shell(guest: Guest, facts: BootFacts) {
  let kernel = "wasm32";
  try {
    const uname = await guest.exec(["uname", "-rm"]);
    kernel = (await new Response(uname.stdout).text()).trim();
  } catch {
    // Cosmetic only, the motd just names the architecture instead.
  }

  const env = { TERM: "xterm-256color", MOTD: motd(kernel, facts) };
  for (;;) {
    try {
      const process = await guest.exec(
        [
          "sh",
          "-c",
          `clear >/dev/hvc0; printf '%s\\n' "$MOTD" >/dev/hvc0; unset MOTD; exec setsid cttyhack sh </dev/hvc0 >/dev/hvc0 2>&1`,
        ],
        { env },
      );
      await process.status;
    } catch (error) {
      console.error("console shell failed:", error);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let assets: { initramfs: Uint8Array; rootfs: Uint8Array } | undefined;
const bootPhase = Promise.withResolvers<void>();
export const booting = bootPhase.promise;

async function boot(): Promise<Hero> {
  if (!globalThis.crossOriginIsolated) {
    throw new Error("this page is not cross-origin isolated");
  }

  const network = createNetwork({
    async connectTcp() {
      throw new Error("this network has no internet access");
    },
    async resolveDns() {
      return [];
    },
  });

  const [initramfs, rootfs] = await Promise.all([
    fetchBytes("/initramfs.cpio.gz"),
    fetchBytes("/rootfs.squashfs.gz"),
  ]);
  assets = { initramfs, rootfs };

  const cpus = Math.min(navigator.hardwareConcurrency, 4);
  const start = performance.now();
  bootPhase.resolve();
  const guest = await spawnGuest({
    cpus,
    network,
    assets,
    devices: [terminalConsole, entropyDevice(), ...graphicalDevices],
  });
  const bootMs = Math.round(performance.now() - start);

  // The early boot console and /dev/hvc0 are separate output streams. Drain
  // the former first so the shell's clear cannot be followed by buffered boot
  // messages arriving out of order.
  await guest.machine.bootConsole.pipeTo(consoleSink(), { preventClose: true });
  void shell(guest, { cpus, bootMs, rootfsBytes: rootfs.byteLength });

  return { guest, network, bootMs, cpus, rootfsBytes: rootfs.byteLength };
}

export const hero: Promise<Hero> = boot();

// spawnGuest as handed to the runnable examples: a real spawn with the page's
// assets and network filled in, and previous example-spawned machines closed
// first so repeated clicks don't accumulate guests.
const peers = new Set<Guest>();

export async function spawnPeer(options: Partial<SpawnGuestOptions> = {}): Promise<NetworkedGuest> {
  const { network } = await hero;
  for (const peer of peers) {
    peer.machine.close();
    peers.delete(peer);
  }
  const peer = await spawnGuest({
    cpus: 1,
    assets,
    devices: [entropyDevice()],
    ...options,
    network,
  });
  void peer.machine.bootConsole.pipeTo(new WritableStream()).catch(() => {});
  peers.add(peer);
  return peer;
}
