import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  BlockDevice,
  ConsoleDevice,
  EntropyDevice,
  Machine,
} from "./build/linux";
import "./style.css";

const terminal = new Terminal({
  convertEol: true,
  fontFamily: "monospace",
});

{
  const terminal_fit = new FitAddon();
  terminal.loadAddon(terminal_fit);
  terminal.open(document.body);
  terminal_fit.fit();
  window.onresize = () => terminal_fit.fit();
}

try {
  terminal.loadAddon(new WebglAddon());
} catch (err) {
  console.warn(err);
}

if (!window.crossOriginIsolated) {
  terminal.write("Error: not cross origin isolated\n");
}

const {
  cmdline = "",
  memory = navigator.hardwareConcurrency > 16 ? 256 : 128,
  initcpio: initcpio_path = new URL("./build/initcpio", import.meta.url).href,
} = Object.fromEntries(new URLSearchParams(location.search));

(document.querySelector("input[name=cmdline]") as HTMLInputElement).value =
  cmdline;
(document.querySelector("input[name=memory]") as HTMLInputElement).value =
  String(memory);
(document.querySelector("input[name=initcpio]") as HTMLInputElement).value =
  initcpio_path;

const initcpio = await fetch(initcpio_path).then((res) =>
  res.ok ? res.arrayBuffer() : null,
);
if (!initcpio) {
  terminal.write(`Failed to fetch initramfs.\n`);
}

const stdin = new ReadableStream<string>({
  start(controller) {
    terminal.onData((data) => {
      controller.enqueue(data);
    });
  },
}).pipeThrough(new TextEncoderStream());

const stdout = new WritableStream<Uint8Array>({
  write(chunk) {
    terminal.write(chunk);
  },
});
const stdout2 = new WritableStream<Uint8Array>({
  write(chunk) {
    terminal.write(chunk);
  },
});

const machine = new Machine({
  cmdline: cmdline.replace(/\+/g, " "),
  memoryMib: Number(memory),
  devices: [
    new ConsoleDevice(stdin, stdout),
    new EntropyDevice(),
    new BlockDevice(new Uint8Array(8 * 1024 * 1024)),
  ],
  initcpio: initcpio ? new Uint8Array(initcpio) : undefined,
});

// machine.bootConsole.pipeTo(stdout2);

machine.on("halt", () => {
  terminal.write("halting...");
});

machine.on("restart", () => {
  location.reload();
});

machine.on("error", ({ error, threadName }) => {
  terminal.write(`${error.name} in ${threadName}: ${error.message}\n`);
});

machine.boot();
