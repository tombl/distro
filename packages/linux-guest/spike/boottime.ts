// PROTOTYPE (redesign phase 0 spike), risk (e): boot latency from the start
// of bootMachine() to the first successful run(["true"]).
//   node spike/boottime.ts old   today's agent disk + LOWLAND_ROOT label scan
//   node spike/boottime.ts new   initramfs agent + host-driven mounts + switch_root
// Prints one JSON line; run each in a fresh process.
import { blockDevice, bootMachine } from "@lowland/kernel";
import { create_guest_client } from "../src/client.ts";
import { guestAgent } from "../src/index.ts";
import { root_device, rootfs } from "../tests/assets.ts";
import { hostBoot, initramfsAgent } from "./lib.ts";

const mode = process.argv[2];
const cpus = Number(process.env.SPIKE_CPUS ?? 2);
const marks: Record<string, number> = {};
const t0 = performance.now();
const mark = (name: string) => (marks[name] = +(performance.now() - t0).toFixed(1));

async function run_true(run: () => Promise<{ status: { success: boolean } }>) {
  const result = await run();
  if (!result.status.success) throw new Error("true failed");
}

if (mode === "old") {
  const guest = guestAgent();
  const machine = await bootMachine({ cpus, plugins: [guest, root_device()] });
  mark("bootMachine resolved (agent ready)");
  await run_true(() => guest.run(["true"]));
  mark("run true");
  machine.close();
  await machine.closed;
} else if (mode === "new") {
  const agent = initramfsAgent();
  const root = blockDevice(
    {
      capacity: rootfs.byteLength,
      read(offset, target) {
        const source = rootfs.subarray(offset, offset + target.byteLength);
        target.set(source);
        return source.byteLength;
      },
    },
    { serial: "m0" },
  );
  const machine = await bootMachine({ cpus, plugins: [agent.plugin, root] });
  mark("bootMachine resolved");
  await hostBoot(
    agent.vsock,
    [
      { path: "/", serial: "m0", type: "erofs", mode: "overlay" },
      { path: "/run", type: "tmpfs", mode: "rw" },
      { path: "/tmp", type: "tmpfs", mode: "rw" },
    ],
    { trace: (step) => mark(step) },
  );
  const client = create_guest_client(agent.vsock);
  await client.ping(5000);
  mark("post-switch session ready");
  await run_true(async () => {
    const child = await client.exec(["true"]);
    const [status] = await Promise.all([
      child.status,
      child.stdout.cancel(),
      child.stderr.cancel(),
      child.stdin.close(),
    ]);
    return { status };
  });
  mark("run true");
  machine.close();
  await machine.closed;
} else {
  throw new Error("usage: boottime.ts old|new");
}
console.log(JSON.stringify({ mode, cpus, total: marks["run true"], marks }));
