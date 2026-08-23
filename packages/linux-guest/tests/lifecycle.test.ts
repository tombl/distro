import { bootConsole, bootMachine, consoleDevice, MachinePanicError } from "@lowland/kernel";
import type { MachinePlugin } from "@lowland/kernel/plugin";
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
  const machine = await bootMachine({
    args: [`lifecycle=${mode}`],
    cpus: 1,
    plugins: [
      bootConsole(output_sink(output)),
      lifecycle_assets.root(),
      consoleDevice(closed_input(), output_sink(output)),
    ],
    initcpio: lifecycle_assets.initramfs,
  });
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

test("a booted hook failure closes the machine before bootMachine rejects", async () => {
  const failure = new Error("booted hook failed");
  let machine_closed: Promise<void> | undefined;
  const plugin: MachinePlugin = {
    configure() {},
    booted(machine) {
      machine_closed = machine.closed;
      throw failure;
    },
  };

  await assert.rejects(
    bootMachine({
      cpus: 1,
      initcpio: lifecycle_assets.initramfs,
      plugins: [lifecycle_assets.root(), plugin],
    }),
    (error) => error === failure,
  );
  assert(machine_closed);
  await machine_closed;
});
