import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { BlockDevice, ConsoleDevice, EntropyDevice, Machine } from "@tombl/linux";
import "./style.css";

if (import.meta.env.PROD) {
  function reportError(error: unknown) {
    alert(`${error}`);
  }

  addEventListener("error", (event) => reportError(event.error));
  addEventListener("unhandledrejection", (event) => reportError(event.reason));
}

const details = document.querySelector("details");
if (!details) throw new Error("details element not found");

const savedDetailsOpen = localStorage.getItem("detailsOpen");
if (savedDetailsOpen !== null) {
  details.open = savedDetailsOpen === "true";
}
details.addEventListener("toggle", () => {
  localStorage.setItem("detailsOpen", details.open.toString());
});

const term = new Terminal({
  convertEol: true,
  fontFamily: "monospace",
});
const termFit = new FitAddon();
term.loadAddon(termFit);
term.open(document.body);
termFit.fit();
window.onresize = () => termFit.fit();
try {
  term.loadAddon(new WebglAddon());
} catch (err) {
  console.warn(err);
}

if (!window.crossOriginIsolated) {
  term.write("Error: not cross origin isolated\n");
}

const {
  cmdline = "",
  memory = navigator.hardwareConcurrency > 16 ? "256" : "128",
  initcpio: initcpioPath = "initramfs.cpio.gz",
  rootfs: rootfsPath = "rootfs.ext4.gz",
} = Object.fromEntries(new URLSearchParams(location.search));

const cmdlineInput = document.querySelector<HTMLInputElement>("input[name=cmdline]");
const memoryInput = document.querySelector<HTMLInputElement>("input[name=memory]");
const initcpioInput = document.querySelector<HTMLInputElement>("input[name=initcpio]");
const rootfsInput = document.querySelector<HTMLInputElement>("input[name=rootfs]");

if (!cmdlineInput || !memoryInput || !initcpioInput || !rootfsInput) {
  throw new Error("form inputs not found");
}

cmdlineInput.value = cmdline;
memoryInput.value = memory;
initcpioInput.value = initcpioPath;
rootfsInput.value = rootfsPath;

const stdin = new ReadableStream<string>({
  start(controller) {
    term.onData((data) => {
      controller.enqueue(data);
    });
  },
}).pipeThrough(new TextEncoderStream());

const stdout = new WritableStream<Uint8Array>({
  write(chunk) {
    term.write(chunk);
  },
});
const stdout2 = new WritableStream<Uint8Array>({
  write(chunk) {
    term.write(chunk);
  },
});

async function fetchBytes(path: string): Promise<Uint8Array | null> {
  let response = await fetch(path);
  if (!response.ok) {
    return null;
  }
  if (path.endsWith(".gz") && response.headers.get("Content-Encoding") !== "gzip") {
    if (!response.body) return null;
    response = new Response(response.body.pipeThrough(new DecompressionStream("gzip")));
  }
  return new Uint8Array(await response.arrayBuffer());
}

const initcpio = await fetchBytes(initcpioPath);
if (!initcpio) {
  term.write("Failed to fetch initramfs.\n");
}

const rootfs = await fetchBytes(rootfsPath);
if (!rootfs) {
  term.write("Failed to fetch root filesystem.\n");
}

if (!initcpio || !rootfs) {
  throw new Error("failed to load boot assets");
}

const rootfsData = new Uint8Array(rootfs);

const machine = new Machine({
  cmdline: cmdline.replace(/\+/g, " "),
  memoryMib: parseInt(memory, 10),
  devices: [
    new ConsoleDevice(stdin, stdout),
    new EntropyDevice(),
    new BlockDevice({
      capacity: rootfsData.byteLength,
      read(offset, length) {
        return rootfsData.subarray(offset, offset + length);
      },
      write(offset, data) {
        rootfsData.set(data, offset);
        return data.byteLength;
      },
    }),
  ],
  initcpio: new Uint8Array(initcpio),
});

machine.bootConsole.pipeTo(stdout2);

machine.boot();
