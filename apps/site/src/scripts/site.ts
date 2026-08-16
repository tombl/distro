import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import {
  blockDevice,
  bootMachine,
  type BlockDeviceStorage,
  consoleDevice,
  entropyDevice,
  fileSystemDevice,
  type VirtioDevice,
  workerDevice,
} from "@lowland/kernel";
import type { MachinePluginInput } from "@lowland/kernel/plugin";
import { createNetwork, guestAgent, guestFetchHandler, hostFetchNetwork } from "@lowland/guest";
import { BrowserFS } from "@lowland/guest/browser";
import { serveGuest } from "@lowland/bridge-site/client";

const terminalElement = document.querySelector<HTMLElement>("[data-terminal]");
const placeholderElement = document.querySelector<HTMLElement>("[data-terminal-placeholder]");

function reportError(error: unknown) {
  console.error(error);
  // The placeholder is the no-JavaScript face of the panel; a load failure
  // keeps it mounted and rewrites it in place rather than losing it.
  if (placeholderElement) {
    placeholderElement.textContent = [
      "The machine could not start.",
      "",
      String(error),
      "",
      "Continue with the documentation or inspect the source.",
    ].join("\n");
  } else {
    term.write(`\r\nThe machine could not start: ${String(error)}\r\n`);
  }
}

addEventListener("error", (event) => reportError(event.error));
addEventListener("unhandledrejection", (event) => reportError(event.reason));

if (!(terminalElement instanceof HTMLElement)) throw new Error("the terminal element is missing");

const persistentInstallSupported = !navigator.userAgent.includes("Firefox/");
let bootMode = persistentInstallSupported ? (import.meta.env.PUBLIC_BOOT_MODE ?? "live") : "live";
if ("serviceWorker" in navigator) {
  if (!persistentInstallSupported) {
    await (await navigator.serviceWorker.getRegistration("/"))?.unregister();
    if (navigator.serviceWorker.controller) {
      location.reload();
      await new Promise(() => {});
    }
  } else if (bootMode === "live" || !navigator.serviceWorker.controller) {
    await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
  }
}

const parameters = Object.fromEntries(new URLSearchParams(location.search));
const cpuCount = Math.max(1, Math.min(navigator.hardwareConcurrency || 1, 4));

// xterm needs resolved colors rather than CSS color functions such as
// light-dark(). A short-lived element lets the browser resolve each shared
// theme variable for the active color scheme.
function resolveColor(variable: string) {
  const probe = document.createElement("span");
  probe.style.color = `var(${variable})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

function terminalTheme() {
  return {
    background: resolveColor("--code-background"),
    foreground: resolveColor("--terminal-foreground"),
    cursor: resolveColor("--terminal-cursor"),
    cursorAccent: resolveColor("--code-background"),
    selectionBackground: resolveColor("--terminal-selection-background"),
    selectionForeground: resolveColor("--terminal-selection-foreground"),
    black: resolveColor("--terminal-black"),
    red: resolveColor("--terminal-red"),
    green: resolveColor("--terminal-green"),
    yellow: resolveColor("--terminal-yellow"),
    blue: resolveColor("--terminal-blue"),
    magenta: resolveColor("--terminal-magenta"),
    cyan: resolveColor("--terminal-cyan"),
    white: resolveColor("--terminal-white"),
    brightBlack: resolveColor("--terminal-bright-black"),
    brightRed: resolveColor("--terminal-bright-red"),
    brightGreen: resolveColor("--terminal-bright-green"),
    brightYellow: resolveColor("--terminal-bright-yellow"),
    brightBlue: resolveColor("--terminal-bright-blue"),
    brightMagenta: resolveColor("--terminal-bright-magenta"),
    brightCyan: resolveColor("--terminal-bright-cyan"),
    brightWhite: resolveColor("--terminal-bright-white"),
  };
}

const term = new Terminal({
  convertEol: true,
  cursorBlink: true,
  drawBoldTextInBrightColors: false,
  fontFamily: getComputedStyle(terminalElement).fontFamily,
  fontSize: 15,
  theme: terminalTheme(),
});
const termFit = new FitAddon();

const disclosures = Array.from(document.querySelectorAll("[data-persist-disclosure]")).filter(
  (element) => element instanceof HTMLDetailsElement,
);
const storedDisclosure = localStorage.getItem("detailsOpen");
if (storedDisclosure !== null) {
  for (const disclosure of disclosures) disclosure.open = storedDisclosure === "true";
}
let synchronizingDisclosures = false;
for (const disclosure of disclosures) {
  disclosure.addEventListener("toggle", () => {
    if (synchronizingDisclosures) return;
    synchronizingDisclosures = true;
    for (const peer of disclosures) peer.open = disclosure.open;
    synchronizingDisclosures = false;
    localStorage.setItem("detailsOpen", String(disclosure.open));
    requestAnimationFrame(() => termFit.fit());
  });
}
term.loadAddon(termFit);
term.open(terminalElement);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  term.options.theme = terminalTheme();
});
termFit.fit();
addEventListener("resize", () => {
  termFit.fit();
  mirrorPlaceholderMetrics();
});

if (parameters.webgl !== "0") {
  try {
    term.loadAddon(new WebglAddon());
  } catch (error) {
    console.warn(error);
  }
}
// The placeholder and the terminal must share the same text metrics so the
// swap is invisible. xterm renders into fixed-width cells whose geometry is
// authoritative; mirror the measured row height and cell width back into the
// CSS custom properties the placeholder styles read. The cell width in turn
// determines the placeholder's letter spacing: xterm pads each glyph to its
// cell, so the placeholder must add the same spacing to advance identically.
const machineElement = terminalElement.closest<HTMLElement>(".machine");

function measureCellWidth(): number | undefined {
  if (!terminalElement) return undefined;
  const screen = terminalElement.querySelector<HTMLElement>(".xterm-screen");
  if (screen && term.cols > 0) {
    const width = screen.getBoundingClientRect().width / term.cols;
    if (width > 0) return width;
  }
  // Fall back to xterm's own cell dimensions when the screen isn't painted.
  const internal = (
    term as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } } };
    }
  )._core?._renderService?.dimensions?.css?.cell?.width;
  return internal && internal > 0 ? internal : undefined;
}

function measureNaturalAdvance(): number | undefined {
  if (!placeholderElement) return undefined;
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(20);
  probe.style.cssText = [
    "position: absolute",
    "visibility: hidden",
    "white-space: pre",
    `font-family: var(--font-mono, ui-monospace, monospace)`,
    `font-size: ${term.options.fontSize}px`,
    `line-height: ${term.options.lineHeight}`,
    "letter-spacing: 0",
  ].join(";");
  placeholderElement.append(probe);
  const width = probe.getBoundingClientRect().width / 20;
  probe.remove();
  return width;
}

function mirrorPlaceholderMetrics() {
  if (!machineElement || !terminalElement) return;
  const screen = terminalElement.querySelector<HTMLElement>(".xterm-screen");
  if (screen && term.rows > 0) {
    const lineHeight = screen.getBoundingClientRect().height / term.rows;
    machineElement.style.setProperty("--terminal-line-height", `${lineHeight}px`);
  }
  machineElement.style.setProperty("--terminal-font-size", `${term.options.fontSize}px`);
  const cellWidth = measureCellWidth();
  const advance = measureNaturalAdvance();
  if (cellWidth !== undefined && advance !== undefined) {
    const spacing = cellWidth - advance;
    machineElement.style.setProperty("--terminal-letter-spacing", `${spacing}px`);
  }
}
// Measure after the terminal has actually painted (WebGL needs a frame), so
// the mirrored geometry reflects the real cell size rather than a pre-layout
// guess.
requestAnimationFrame(() => mirrorPlaceholderMetrics());

// The placeholder is a stand-in for a server-rendered terminal: the `<pre>`
// shows the message when JavaScript cannot run. The handover happens at the
// first frame of JavaScript — xterm mounts and is given the placeholder's
// exact text, then the `<pre>` is removed only once that write has actually
// rendered (so the exposed terminal already shows identical cells). It is a
// hydration stand-in, not a loading screen: the terminal never starts empty,
// and the boot log streams in after the swap.
let terminalReady = false;
function swapToTerminal() {
  if (terminalReady) return;
  terminalReady = true;
  const text = placeholderElement?.textContent ?? "";
  if (text) {
    term.write(text, () => {
      // Let the terminal paint the placeholder text before exposing it, and
      // re-measure its geometry now that it has actually rendered.
      requestAnimationFrame(() => {
        mirrorPlaceholderMetrics();
        placeholderElement?.remove();
        termFit.fit();
      });
    });
  } else {
    placeholderElement?.remove();
  }
}

// Normal flow: hydrate the placeholder into the terminal at the first frame
// of JavaScript — xterm is given the placeholder's exact text and the `<pre>`
// is removed once that text has rendered, as if the terminal had been
// server-rendered and then hydrated. The boot log streams in after.
swapToTerminal();

if (!window.crossOriginIsolated) throw new Error("This page is not cross-origin isolated.");

let opfs;
try {
  opfs = await navigator.storage.getDirectory();
} catch (error) {
  console.warn("Persistent storage is unavailable; continuing in live-only mode", error);
  bootMode = "live";
}

const { cmdline = "" } = parameters;
const stdin = new ReadableStream({
  start(controller) {
    term.onData((data) => controller.enqueue(data));
  },
}).pipeThrough(new TextEncoderStream());

const toTerminal = (data: string | ArrayLike<number>) =>
  new Promise<void>((resolve) =>
    term.write(typeof data === "string" ? data : Uint8Array.from(data), resolve),
  );

// The kernel emits pre-console printk through the boot console stream and
// everything after hvc0 takes over through the virtio tty console. Stream the
// boot log into the terminal live, but hold the tty console's first output
// until the boot stream has closed (hvc0 handoff), so the log reads as one
// ordered block rather than interleaving with the motd.
let releaseTty: () => void = () => {};
const ttyGate = new Promise<void>((resolve) => {
  releaseTty = resolve;
});
const bootOut = new WritableStream({
  write(chunk) {
    return toTerminal(chunk);
  },
});
const stdout = new WritableStream({
  async write(chunk) {
    await ttyGate;
    return toTerminal(chunk);
  },
});
const ttyConsole = consoleDevice(stdin, stdout);
const resizeConsole = () => ttyConsole.resize(term.cols, term.rows);
term.onResize(resizeConsole);
resizeConsole();

async function openLiveDisk(): Promise<BlockDeviceStorage> {
  const manifestResponse = await fetch("/rootfs.erofs.json");
  if (!manifestResponse.ok) {
    throw new Error(`failed to fetch rootfs manifest: ${manifestResponse.status}`);
  }
  const { sha, size } = await manifestResponse.json();
  const url = `/rootfs-${sha}.erofs`;
  const chunkSize = 256 * 1024;
  const chunks = new Map<number, Promise<Uint8Array>>();
  let whole: Uint8Array | undefined;

  const loadChunk = (index: number): Promise<Uint8Array> => {
    if (!chunks.has(index)) {
      chunks.set(
        index,
        (async () => {
          const start = index * chunkSize;
          const end = Math.min(start + chunkSize, size);
          const response = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
          if (response.status === 200) {
            whole = new Uint8Array(await response.arrayBuffer());
            if (whole.byteLength !== size) throw new Error("rootfs has the wrong size");
            return whole.subarray(start, end);
          }
          if (response.status !== 206) {
            throw new Error(`failed to fetch rootfs range: ${response.status}`);
          }
          const data = new Uint8Array(await response.arrayBuffer());
          if (data.byteLength !== end - start) throw new Error("short rootfs range response");
          return data;
        })(),
      );
    }
    return chunks.get(index)!;
  };

  return {
    capacity: size,
    async read(offset: number, target: Uint8Array) {
      const length = target.byteLength;
      if (offset < 0 || length < 0 || offset + length > size) {
        throw new RangeError("rootfs read is outside the disk");
      }
      if (whole) {
        target.set(whole.subarray(offset, offset + length));
        return length;
      }
      const first = Math.floor(offset / chunkSize);
      const last = Math.floor((offset + length - 1) / chunkSize);
      const loaded = await Promise.all(
        Array.from({ length: last - first + 1 }, (_, index) => loadChunk(first + index)),
      );
      for (let index = 0; index < loaded.length; index++) {
        const chunkIndex = first + index;
        const chunkStart = chunkIndex * chunkSize;
        const from = Math.max(offset, chunkStart);
        const to = Math.min(offset + length, chunkStart + loaded[index].byteLength);
        target.set(loaded[index].subarray(from - chunkStart, to - chunkStart), from - offset);
      }
      return length;
    },
  };
}

type InstallDiskOptions = {
  directory: FileSystemDirectoryHandle;
  requireFilesystem: boolean;
  timeout?: number;
};

async function openInstallDisk({
  directory,
  requireFilesystem,
  timeout,
}: InstallDiskOptions): Promise<VirtioDevice | undefined> {
  const handle = await directory.getFileHandle("root.ext4", { create: true });
  const file = await handle.getFile();
  const magicOffset = 1024 + 56;
  const magic = new Uint8Array(await file.slice(magicOffset, magicOffset + 2).arrayBuffer());
  const hasFilesystem = file.size >= magicOffset + 2 && magic[0] === 0x53 && magic[1] === 0xef;
  if (requireFilesystem && !hasFilesystem) {
    throw new Error("persistent disk is not a valid ext4 image");
  }
  if (!requireFilesystem && hasFilesystem) return undefined;

  const worker = new Worker(new URL("./opfs-disk-worker.ts", import.meta.url), { type: "module" });
  const devicePromise = workerDevice(worker);
  worker.postMessage({
    handle,
    capacity: file.size === 0 ? 64 * 1024 * 1024 : undefined,
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    if (timeout === undefined) return;
    timeoutId = setTimeout(() => reject(new Error("persistent disk worker timed out")), timeout);
  });
  try {
    const device = await Promise.race([devicePromise, timeoutPromise]);
    clearTimeout(timeoutId);
    void device.closed.finally(() => worker.terminate()).catch(() => {});
    return device;
  } catch (error) {
    clearTimeout(timeoutId);
    worker.terminate();
    throw error;
  }
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

const network = createNetwork(hostFetchNetwork({ fetch: (request) => fetch(request) }));
const disk: MachinePluginInput =
  bootMode === "live"
    ? blockDevice(await openLiveDisk())
    : requireValue(
        await openInstallDisk({
          directory: requireValue(opfs, "persistent storage is unavailable"),
          requireFilesystem: true,
        }),
        "persistent disk already contains a filesystem",
      );
let installDisk: VirtioDevice | undefined;
if (bootMode === "live" && persistentInstallSupported && opfs) {
  try {
    installDisk = await openInstallDisk({
      directory: opfs,
      requireFilesystem: false,
      timeout: 2000,
    });
  } catch (error) {
    console.warn("Persistent installation is unavailable; continuing with the live system", error);
  }
}
const bootDirectory = opfs ? await opfs.getDirectoryHandle("boot", { create: true }) : undefined;
const guest = guestAgent();
const networkAttachment = network.attach(guest);

const args: string[] = [];
if (bootMode === "live") args.push("lowland.root.overlay=tmpfs");
if (installDisk) args.push("lowland.install=1");
const extraArgs = cmdline.replace(/\+/g, " ");
if (extraArgs) args.push(extraArgs);

const plugins: MachinePluginInput[] = [guest, ttyConsole];
if (installDisk) plugins.push(installDisk);
plugins.push(entropyDevice());
if (bootDirectory) {
  plugins.push(fileSystemDevice(new BrowserFS(bootDirectory), { tag: "boot", cache: false }));
}
plugins.push(disk);
plugins.push(networkAttachment);

const machine = await bootMachine({
  cpus: cpuCount,
  args,
  plugins,
});
// Route the kernel's boot output into the terminal, which already holds the
// hydrated placeholder text. Releasing the tty gate lets the guest's motd
// follow once the boot console stream closes (hvc0 handoff).
void machine.bootConsole
  .pipeTo(bootOut)
  .then(releaseTty)
  .catch(() => {});
setTimeout(releaseTty, 5000);

if (bootDirectory) {
  await guest.fs.mkdir("/boot", { recursive: true });
  await guest.mount("boot", "/boot", { type: "virtiofs" });
}
terminalElement.setAttribute("aria-busy", "false");
termFit.fit();

if (location.origin === "https://low.land") {
  serveGuest({
    hub: "https://hub.localhost.low.land",
    fetch: (port) => guestFetchHandler(networkAttachment, { port }),
  });
}
