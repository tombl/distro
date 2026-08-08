import { consoleDevice, spawnMachine } from "@tombl/linux";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function required_environment(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}

const initramfs = required_environment("LINUX_RUNNER_TEST_CONSOLE_INITRAMFS");

function output_sink(output: { text: string }) {
  const decoder = new TextDecoder();
  return new WritableStream<Uint8Array>({
    write(chunk) {
      output.text += decoder.decode(chunk, { stream: true });
    },
    close() {
      output.text += decoder.decode();
    },
  });
}

test("console preserves input queued before boot", { timeout: 45_000 }, async (t) => {
  const output = { text: "" };
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("queued before boot\n"));
      controller.close();
    },
  });
  const machine = await spawnMachine({
    cpus: 1,
    devices: [consoleDevice(input, output_sink(output))],
    initcpio: readFile(initramfs),
  });
  t.after(() => machine.close());
  void machine.bootConsole.pipeTo(output_sink(output)).catch(() => {});

  await machine.closed;
  assert.match(output.text, /console-input: queued before boot/, output.text);
});
