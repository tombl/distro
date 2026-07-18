import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const [module_path, network_test_path] = Deno.args;
if (!module_path || !network_test_path || Deno.args.length !== 2) {
  throw new Error("usage: integration-test.ts <linux-guest-module> <network-test>");
}

const {
  consoleDevice,
  createNetwork,
  entropyDevice,
  SeekMode,
  SystemError,
  spawnGuest,
}: typeof import("./src/index.ts") = await import(pathToFileURL(module_path).href);

function closed_input() {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function console_output() {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      Deno.stderr.writeSync(chunk);
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function connect_with_retry<T>(connect: () => Promise<T>) {
  let failure: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await connect();
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("guest listener did not become ready", { cause: failure });
}

const boot_console = console_output();
const network = createNetwork({
  connectTcp: (options) => Deno.connect({ ...options, transport: "tcp" }),
  resolveDns: (hostname) => Deno.resolveDns(hostname, "A"),
});
const {
  machine,
  fs,
  exec,
  network: guest_network,
} = await spawnGuest({
  cpus: 2,
  memoryMib: 192,
  network,
  devices: [consoleDevice(closed_input(), console_output()), entropyDevice()],
});
const boot_console_done = machine.bootConsole.pipeTo(boot_console, { preventClose: true });

try {
  await fs.writeFile("/workspace/network-test", await Deno.readFile(network_test_path));
  await fs.chmod("/workspace/network-test", 0o755);
  const network_configuration = await exec(["sh", "-c", "ip address; ip route"]);
  const [network_configuration_output, network_configuration_error, network_configuration_status] =
    await Promise.all([
      collect(network_configuration.stdout),
      collect(network_configuration.stderr),
      network_configuration.status,
    ]);
  assert.deepEqual(network_configuration_status, { success: true, code: 0, signal: null });
  assert.equal(network_configuration_error.byteLength, 0);
  const configured_network = new TextDecoder().decode(network_configuration_output);
  assert.match(configured_network, /inet 192\.0\.2\.2\/24/);
  assert.match(configured_network, /default via 192\.0\.2\.1 dev eth0/);
  await assert.rejects(
    fs.writeTextFile("/immutable.txt", "nope"),
    (error) => error instanceof SystemError && error.code === "EROFS",
  );

  await fs.mkdir("/workspace/tree/child", { recursive: true });
  await fs.writeTextFile("/workspace/tree/hello.txt", "hello, guest\n");
  assert.equal(await fs.readTextFile("/workspace/tree/hello.txt"), "hello, guest\n");

  const info = await fs.stat("/workspace/tree/hello.txt");
  assert.equal(info.isFile, true);
  assert.equal(info.size, 13);

  const entries = [];
  for await (const entry of fs.readDir("/workspace/tree")) entries.push(entry);
  assert.deepEqual(entries.map((entry: { name: string }) => entry.name).sort(), [
    "child",
    "hello.txt",
  ]);

  await fs.symlink("hello.txt", "/workspace/tree/link");
  assert.equal((await fs.lstat("/workspace/tree/link")).isSymlink, true);
  assert.equal(await fs.readLink("/workspace/tree/link"), "hello.txt");
  assert.equal(await fs.realPath("/workspace/tree/link"), "/workspace/tree/hello.txt");

  await fs.copyFile("/workspace/tree/hello.txt", "/workspace/tree/copied.txt");
  await assert.rejects(
    fs.copyFile("/workspace/tree/hello.txt", "/workspace/tree/hello.txt"),
    (error) => error instanceof SystemError && error.code === "EINVAL",
  );
  assert.equal(await fs.readTextFile("/workspace/tree/hello.txt"), "hello, guest\n");
  await fs.rename("/workspace/tree/copied.txt", "/workspace/tree/renamed.txt");
  await fs.chmod("/workspace/tree/renamed.txt", 0o600);
  assert.equal((await fs.stat("/workspace/tree/renamed.txt")).mode & 0o777, 0o600);
  await fs.truncate("/workspace/tree/renamed.txt", 5);
  assert.equal(await fs.readTextFile("/workspace/tree/renamed.txt"), "hello");

  const file = await fs.open("/workspace/tree/open.txt", {
    create: true,
    read: true,
    truncate: true,
    write: true,
  });
  assert.equal(await file.write(new TextEncoder().encode("abcdef")), 6);
  assert.equal(await file.seek(-3, SeekMode.End), 3);
  const tail = new Uint8Array(3);
  assert.equal(await file.read(tail), 3);
  assert.equal(new TextDecoder().decode(tail), "def");
  await file.sync();
  await file.close();

  const appended = await fs.open("/workspace/tree/open.txt", { append: true });
  assert.equal(await appended.write(new TextEncoder().encode("ghi")), 3);
  await appended.close();
  assert.equal(await fs.readTextFile("/workspace/tree/open.txt"), "abcdefghi");

  // Open files are plain guest fds (the v1 agent pinned a worker per open
  // file and rejected the 12th with EAGAIN); more opens than the agent has
  // workers must coexist with other traffic.
  const retained = await Promise.all(
    Array.from({ length: 32 }, () => fs.open("/workspace/tree/open.txt")),
  );
  try {
    assert.equal((await fs.stat("/workspace/tree/open.txt")).size, 9);
  } finally {
    await Promise.all(retained.map((retained_file) => retained_file.close()));
  }

  const large = new Uint8Array(256 * 1024);
  for (let i = 0; i < large.length; i++) large[i] = i & 0xff;
  await fs.writeFile("/workspace/large.bin", large);
  assert.deepEqual(await fs.readFile("/workspace/large.bin"), large);

  const child = await exec(["sh", "-c", 'cat; printf \'%s:%s\' "$GREETING" "$PWD" >&2'], {
    cwd: "/workspace/tree",
    env: { GREETING: "hello" },
  });
  const stdin = child.stdin.getWriter();
  await stdin.write(large);
  await stdin.close();
  const [stdout, stderr, status] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    child.status,
  ]);
  assert.deepEqual(stdout, large);
  assert.equal(new TextDecoder().decode(stderr), "hello:/workspace/tree");
  assert.deepEqual(status, { success: true, code: 0, signal: null });

  const concurrent = await Promise.all([exec(["cat"]), exec(["cat"])]);
  const concurrent_output = concurrent.map((process) => collect(process.stdout));
  const concurrent_error = concurrent.map((process) => collect(process.stderr));
  const concurrent_status = concurrent.map((process) => process.status);
  assert.equal((await fs.stat("/workspace/large.bin")).size, large.byteLength);
  await Promise.all(
    concurrent.map(async (process, index) => {
      const writer = process.stdin.getWriter();
      await writer.write(large.subarray(index * 32 * 1024, (index + 1) * 32 * 1024));
      await writer.close();
    }),
  );
  for (let index = 0; index < concurrent.length; index++) {
    assert.deepEqual(
      await concurrent_output[index],
      large.subarray(index * 32 * 1024, (index + 1) * 32 * 1024),
    );
    assert.equal((await concurrent_error[index]).byteLength, 0);
    assert.deepEqual(await concurrent_status[index], {
      success: true,
      code: 0,
      signal: null,
    });
  }

  const signalled = await exec(["sleep", "30"]);
  await signalled.kill("SIGTERM");
  assert.deepEqual(await signalled.status, {
    success: false,
    code: 0,
    signal: "SIGTERM",
  });

  const crashed = await exec(["sh", "-c", "kill -SEGV $$"]);
  assert.deepEqual(await crashed.status, {
    success: false,
    code: 0,
    signal: 11,
  });

  const abort_controller = new AbortController();
  const aborted = await exec(["sleep", "30"], {
    signal: abort_controller.signal,
  });
  const abort_reason = new Error("cancel process");
  abort_controller.abort(abort_reason);
  await assert.rejects(aborted.status, (error) => error === abort_reason);

  const orphaned = await exec([
    "sh",
    "-c",
    "sh -c 'i=0; while [ $i -lt 1000 ]; do i=$((i + 1)); done' &",
  ]);
  assert.deepEqual(await orphaned.status, {
    success: true,
    code: 0,
    signal: null,
  });
  const zombie_check = await exec([
    "sh",
    "-c",
    'for stat in /proc/[0-9]*/stat; do case "$(cat "$stat")" in *") Z 1 "*) exit 1;; esac; done',
  ]);
  assert.deepEqual(await zombie_check.status, {
    success: true,
    code: 0,
    signal: null,
  });

  await assert.rejects(
    fs.readFile("/workspace/missing"),
    (error) => error instanceof SystemError && error.code === "ENOENT",
  );

  const tcp_server = await exec(["/workspace/network-test", "listen", "tcp", "12001"]);
  const tcp_server_output = collect(tcp_server.stdout);
  const tcp_server_error = collect(tcp_server.stderr);
  const tcp = await connect_with_retry(() => guest_network.connect({ port: 12001 }));
  const tcp_writer = tcp.writable.getWriter();
  await tcp_writer.write(new TextEncoder().encode("host to guest"));
  await tcp_writer.close();
  assert.equal(new TextDecoder().decode(await collect(tcp.readable)), "host to guest");
  assert.deepEqual(await tcp_server.status, { success: true, code: 0, signal: null });
  assert.equal((await tcp_server_output).byteLength, 0);
  assert.equal((await tcp_server_error).byteLength, 0);

  const udp_server = await exec(["/workspace/network-test", "listen", "udp", "12002"]);
  const udp_server_output = collect(udp_server.stdout);
  const udp_server_error = collect(udp_server.stderr);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const udp = await guest_network.connect({ port: 12002, transport: "udp" });
  const udp_writer = udp.writable.getWriter();
  await udp_writer.write(new TextEncoder().encode("host datagram"));
  const udp_reader = udp.readable.getReader();
  const datagram = await udp_reader.read();
  assert.equal(datagram.done, false);
  assert.equal(new TextDecoder().decode(datagram.value), "host datagram");
  udp.close();
  assert.deepEqual(await udp_server.status, { success: true, code: 0, signal: null });
  assert.equal((await udp_server_output).byteLength, 0);
  assert.equal((await udp_server_error).byteLength, 0);

  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const host_port = listener.addr.port;
  const host_echo = (async () => {
    const connection = await listener.accept();
    listener.close();
    const buffer = new Uint8Array(4096);
    try {
      for (;;) {
        const length = await connection.read(buffer);
        if (length === null) break;
        await connection.write(buffer.subarray(0, length));
      }
    } finally {
      connection.close();
    }
  })();
  const outbound = await exec([
    "/workspace/network-test",
    "connect",
    network.gateway,
    String(host_port),
    "guest to host",
  ]);
  const [outbound_output, outbound_error, outbound_status] = await Promise.all([
    collect(outbound.stdout),
    collect(outbound.stderr),
    outbound.status,
  ]);
  await host_echo;
  assert.equal(new TextDecoder().decode(outbound_output), "guest to host");
  assert.equal(outbound_error.byteLength, 0);
  assert.deepEqual(outbound_status, { success: true, code: 0, signal: null });

  const second_console = console_output();
  const second = await spawnGuest({
    cpus: 2,
    memoryMib: 192,
    network,
    devices: [consoleDevice(closed_input(), console_output()), entropyDevice()],
  });
  const second_console_done = second.machine.bootConsole.pipeTo(second_console, {
    preventClose: true,
  });
  try {
    await second.fs.writeFile("/workspace/network-test", await Deno.readFile(network_test_path));
    await second.fs.chmod("/workspace/network-test", 0o755);
    const guest_server = await exec(["/workspace/network-test", "listen", "tcp", "12003"]);
    const guest_server_output = collect(guest_server.stdout);
    const guest_server_error = collect(guest_server.stderr);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const guest_client = await second.exec([
      "/workspace/network-test",
      "connect",
      guest_network.address,
      "12003",
      "guest to guest",
    ]);
    const [guest_output, guest_error, guest_status] = await Promise.all([
      collect(guest_client.stdout),
      collect(guest_client.stderr),
      guest_client.status,
    ]);
    assert.equal(new TextDecoder().decode(guest_output), "guest to guest");
    assert.equal(guest_error.byteLength, 0);
    assert.deepEqual(guest_status, { success: true, code: 0, signal: null });
    assert.deepEqual(await guest_server.status, { success: true, code: 0, signal: null });
    assert.equal((await guest_server_output).byteLength, 0);
    assert.equal((await guest_server_error).byteLength, 0);
  } finally {
    second.machine.close();
    await second.machine.closed;
    await second_console_done;
  }

  await fs.remove("/workspace/tree", { recursive: true });
  await assert.rejects(fs.stat("/workspace/tree"));
} finally {
  machine.close();
  await machine.closed;
  await boot_console_done;
  network.close();
  const writer = boot_console.getWriter();
  await writer.write(new Uint8Array());
  writer.releaseLock();
}

// Temporary workaround: Deno does not stop a Worker blocked in Wasm
// memory.atomic.wait when terminate() is called. Remove this forced exit once
// https://github.com/denoland/deno/pull/35657 is released.
Deno.exit(0);
