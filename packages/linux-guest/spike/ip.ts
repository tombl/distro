// PROTOTYPE (redesign phase 0 spike), risk (c): the kernel configures the
// network from ip= before /init, with no agent involvement.
//   node spike/ip.ts nic      a NIC and ip=: does boot stall, is the guest configured?
//   node spike/ip.ts none     ip= with no NIC attached: how long does boot wait?
//   node spike/ip.ts baseline neither, for the boot time comparison
import { once } from "node:events";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { blockDevice, bootConsole, bootMachine, consoleDevice } from "@lowland/kernel";
import { create_guest_client } from "../src/client.ts";
import { attach_with_kernel_ip, createNetwork } from "../src/network.ts";
import { rootfs } from "../tests/assets.ts";
import { closed_input } from "../tests/helpers.ts";
import { connect, hostBoot, initramfsAgent } from "./lib.ts";

const mode = process.argv[2] ?? "nic";
const t0 = performance.now();
const at = () => `${(performance.now() - t0).toFixed(0)}ms`;
let log = "";
const decoder = new TextDecoder();
const sink = () =>
  new WritableStream<Uint8Array>({
    write(chunk) {
      log += decoder.decode(Uint8Array.from(chunk));
    },
  });

const network = createNetwork({
  async connectTcp(session) {
    const socket = createConnection({
      host: session.target.hostname,
      port: session.target.port,
      signal: session.signal,
      allowHalfOpen: true,
    });
    await once(socket, "connect");
    const streams = Duplex.toWeb(socket);
    await Promise.all([
      session.readable.pipeTo(streams.writable as WritableStream<Uint8Array>),
      (streams.readable as ReadableStream<Uint8Array>).pipeTo(session.writable),
    ]);
  },
  async resolveDns() {
    return ["192.0.2.1"];
  },
});
const nic = attach_with_kernel_ip(network);

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
const plugins = [bootConsole(sink()), agent.plugin, root, consoleDevice(closed_input(), sink())];
const args: string[] = [];
if (mode === "nic") plugins.push(nic.plugin);
if (mode === "none") args.push(nic.argument);

const machine = await bootMachine({ cpus: 2, args, plugins });
console.log(`bootMachine resolved @${at()}`);
await (await connect(agent.vsock, 300_000)).close();
console.log(`agent session @${at()} (PID 1 is running)`);
const ipconfig = log
  .split("\n")
  .filter((line) => /IP-Config|ipconfig|carrier|eth0|virtio_net/i.test(line));
console.log("kernel log:\n  " + ipconfig.join("\n  "));
const timestamps = log.match(/\[\s*[\d.]+\][^\n]*Run \/init[^\n]*/);
if (timestamps) console.log(timestamps[0]);

if (mode === "nic") {
  await hostBoot(agent.vsock, [
    { path: "/", serial: "m0", type: "erofs", mode: "overlay" },
    { path: "/run", type: "tmpfs", mode: "rw" },
    { path: "/tmp", type: "tmpfs", mode: "rw" },
  ]);
  const client = create_guest_client(agent.vsock);
  const sh = async (command: string) => {
    const child = await client.exec(["sh", "-c", command], { cwd: "/" });
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.stdin.close(),
    ]);
    return `${stdout}${stderr}`.trim() + (status.success ? "" : ` [exit ${status.code}]`);
  };
  console.log("ifconfig:\n" + (await sh("ifconfig -a")));
  console.log("route:\n" + (await sh("route -n")));
  console.log("hostname: " + (await sh("hostname; cat /proc/sys/kernel/hostname")));
  console.log("/proc/net/pnp:\n" + (await sh("cat /proc/net/pnp")));

  const server = createServer((socket) => {
    socket.end("hello from the host\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  console.log(
    `guest TCP to ${network.gateway}:${port}: ` +
      (await sh(`nc ${network.gateway} ${port} </dev/null`)),
  );
  server.close();
}

machine.close();
await machine.closed;
network.close();
console.log(`done @${at()}`);
