import { consoleDevice, MachinePanicError, spawnMachine } from "@tombl/linux";
import assert from "node:assert/strict";
import test from "node:test";
import { lifecycle_assets } from "./assets.ts";
import { closed_input } from "./helpers.ts";

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

async function run_machine(mode: string) {
  const output = { text: "" };
  const machine = await spawnMachine({
    cmdline: `lifecycle=${mode}`,
    cpus: 1,
    devices: [consoleDevice(closed_input(), output_sink(output))],
    initcpio: lifecycle_assets.initramfs,
  });
  void machine.bootConsole.pipeTo(output_sink(output)).catch(() => {});
  return { machine, output };
}

test("guest lifecycle terminates the host", async (t) => {
  await t.test("resolves after poweroff", async () => {
    const { machine } = await run_machine("poweroff");
    await machine.closed;
  });

  await t.test("rejects after a panic with diagnostics visible", async () => {
    const { machine, output } = await run_machine("panic");
    await assert.rejects(machine.closed, MachinePanicError);
    assert.match(output.text, /Kernel panic - not syncing/);
  });
});
