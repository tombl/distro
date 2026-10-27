// The kernel configures a networked machine from ip=, so the network works
// without the agent, and the network's default adapters refuse what they
// were not given.
import assert from "node:assert/strict";
import test from "node:test";
import {
  bootConsole,
  bootMachine,
  consoleDevice,
  createNetwork,
  entropyDevice,
  type Network,
  type NetworkAttachment,
} from "../../src/machine/index.ts";
import { guestAgent, type GuestAgent } from "../../src/guest/index.ts";
import { lifecycle_assets, root_mount } from "./assets.ts";
import { closed_input, collect, connect_with_retry, console_output } from "./helpers.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const KERNEL_IP = "ip=192.0.2.2::192.0.2.1:255.255.255.0:lowland:eth0:off:192.0.2.1";
const PNP = "#MANUAL\nnameserver 192.0.2.1\n";

/** Boots the test image with its agent, attached to `network` if there is one. */
async function with_guest(
  network: Network | undefined,
  fn: (guest: GuestAgent, attachment: NetworkAttachment | undefined) => Promise<void>,
) {
  const agent = guestAgent({ mounts: [root_mount()] });
  const attachment = network?.attach();
  const machine = await bootMachine({
    cpus: 1,
    plugins: [
      agent,
      consoleDevice(closed_input(), console_output()),
      entropyDevice(),
      ...(attachment ? [attachment] : []),
    ],
  });
  try {
    await fn(agent, attachment);
  } finally {
    machine.close();
    await machine.closed;
  }
}

async function sh(guest: GuestAgent, command: string) {
  const result = await guest.run(["/bin/sh", "-c", command]);
  return {
    code: result.status.code,
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
  };
}

test("the kernel configures a networked machine from ip=", async () => {
  using network = createNetwork();
  await with_guest(network, async (guest, attachment) => {
    assert.equal(attachment?.address, "192.0.2.2");
    const cmdline = (await guest.fs.readTextFile("/proc/cmdline")).trim().split(" ");
    assert.deepEqual(
      cmdline.filter((arg) => arg.startsWith("ip=")),
      [KERNEL_IP],
    );
    assert.equal(await guest.fs.readTextFile("/proc/net/pnp"), PNP);

    const { code, output } = await sh(guest, "hostname; ifconfig eth0; ifconfig lo; route -n");
    assert.equal(code, 0, output);
    assert.match(output, /^lowland$/m);
    assert.match(output, /inet addr:192\.0\.2\.2 +Bcast:192\.0\.2\.255 +Mask:255\.255\.255\.0/);
    assert.match(output, /inet addr:127\.0\.0\.1/);
    assert.match(output, /^0\.0\.0\.0 +192\.0\.2\.1 +0\.0\.0\.0 +UG .* eth0$/m);
  });
});

test("a machine without a network has no NIC and no ip=", async () => {
  await with_guest(undefined, async (guest) => {
    const cmdline = await guest.fs.readTextFile("/proc/cmdline");
    assert.doesNotMatch(cmdline, /(^| )ip=/);
    const interfaces: string[] = [];
    for await (const entry of guest.fs.readDir("/sys/class/net")) interfaces.push(entry.name);
    assert.deepEqual(interfaces, ["lo"]);
    assert.equal(await guest.fs.readTextFile("/proc/net/pnp"), "#MANUAL\n");
  });
});

test("an agent-less machine's network is configured before its init runs", async () => {
  using network = createNetwork();
  let output = "";
  const sink = () =>
    new WritableStream<Uint8Array>({
      write(chunk) {
        output += decoder.decode(chunk, { stream: true });
      },
    });
  const machine = await bootMachine({
    args: ["lifecycle=network"],
    cpus: 1,
    plugins: [
      bootConsole(sink()),
      lifecycle_assets.boot(),
      lifecycle_assets.root(),
      consoleDevice(closed_input(), sink()),
      network.attach(),
    ],
  });
  await machine.closed;
  assert.match(output, /^lifecycle: network\r?$/m);
  assert.match(output, /^hostname: lowland\r?$/m);
  assert.match(output, /^nameserver 192\.0\.2\.1\r?$/m);
  assert.match(output, /inet addr:192\.0\.2\.2 +Bcast:192\.0\.2\.255 +Mask:255\.255\.255\.0/);
  assert.match(output, /^0\.0\.0\.0 +192\.0\.2\.1 +0\.0\.0\.0 +UG .* eth0\r?$/m);
});

test("a network without adapters refuses outbound TCP and DNS", async () => {
  using network = createNetwork();
  await with_guest(network, async (guest) => {
    const tcp = await sh(guest, "wget -qO- http://198.51.100.1/");
    assert.notEqual(tcp.code, 0);
    assert.match(tcp.output, /can't connect to remote host \(198\.51\.100\.1\): Connection refused/);
    const gateway = await sh(guest, "wget -qO- http://192.0.2.1/");
    assert.match(gateway.output, /can't connect to remote host \(192\.0\.2\.1\): Connection refused/);
    const dns = await sh(guest, "nslookup example.com");
    assert.notEqual(dns.code, 0);
    assert.match(dns.output, /can't find example\.com: REFUSED/);
  });
});

test("a network without adapters still carries connections into the guest", async () => {
  using network = createNetwork();
  await with_guest(network, async (guest, attachment) => {
    // With its stdin at EOF, nc exits once the host closes.
    const server = await guest.exec(["/bin/sh", "-c", "nc -l -p 8080 </dev/null"]);
    const received = collect(server.stdout);
    const connection = await connect_with_retry(() => attachment!.connect({ port: 8080 }));
    const writer = connection.writable.getWriter();
    await writer.write(encoder.encode("from the host\n"));
    await writer.close();
    assert.equal(decoder.decode(await received), "from the host\n");
    await server.status;
  });
});
