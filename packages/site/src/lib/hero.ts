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
// renders them all, with a backlog for output that arrives before it attaches.
let consoleListener: ((data: Uint8Array) => void) | undefined;
const consoleBacklog: Uint8Array[] = [];

function consoleSink() {
  return new WritableStream<Uint8Array>({
    write(data) {
      if (consoleListener) consoleListener(data);
      else consoleBacklog.push(data);
    },
  });
}

export function attachConsole(listener: (data: Uint8Array) => void) {
  consoleListener = listener;
  for (const data of consoleBacklog) listener(data);
  consoleBacklog.length = 0;
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

// The guest agent is init and starts nothing on the console, so the
// interactive shell is just a process bound to the console tty — respawned
// if it exits. cttyhack gives it a controlling terminal (job control,
// Ctrl+C); the plain redirect is the fallback if the applet is missing.
async function shell(guest: Guest) {
  for (;;) {
    try {
      const process = await guest.exec([
        "sh",
        "-c",
        "clear >/dev/hvc0; exec setsid cttyhack sh </dev/hvc0 >/dev/hvc0 2>&1",
      ]);
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
    devices: [terminalConsole, entropyDevice()],
  });
  const bootMs = Math.round(performance.now() - start);

  // The early boot console and /dev/hvc0 are separate output streams. Drain
  // the former first so the shell's clear cannot be followed by buffered boot
  // messages arriving out of order.
  await guest.machine.bootConsole.pipeTo(consoleSink(), { preventClose: true });
  void shell(guest);

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
