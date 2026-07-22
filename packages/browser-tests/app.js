import { consoleDevice, spawnMachine } from "@tombl/linux";
import { spawnGuest } from "@tombl/linux-guest";

const growModuleBytes = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  0x02, 0x12, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x03,
  0x01, 0xff, 0xff, 0x03, 0x03, 0x02, 0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x67, 0x72, 0x6f, 0x77,
  0x00, 0x00, 0x0a, 0x08, 0x01, 0x06, 0x00, 0x20, 0x00, 0x40, 0x00, 0x0b,
];

const growWorkerSource = `
  const growModule = new WebAssembly.Module(new Uint8Array(${JSON.stringify(growModuleBytes)}));

  self.onmessage = ({ data: { port, role } }) => {
    if (role === "grower") {
      const memory = new WebAssembly.Memory({ initial: 143, maximum: 151, shared: true });
      const instance = new WebAssembly.Instance(growModule, { env: { memory } });
      const before = memory.buffer;
      port.postMessage({ memory, beforeBytes: before.byteLength });
      const previousPages = instance.exports.grow(8);
      self.postMessage({ role, previousPages, beforeBytes: before.byteLength });
      return;
    }

    port.onmessage = ({ data: { memory, beforeBytes } }) => {
      const captured = memory.buffer;
      let stale = false;
      try {
        new Uint8Array(captured, beforeBytes, 4);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        stale = true;
      }
      const actualPages = memory.grow(0);
      self.postMessage({
        role,
        stale,
        actualPages,
        capturedBytes: captured.byteLength,
        refreshedBytes: memory.buffer.byteLength,
      });
    };
    port.start();
  };
`;

async function collectProcess(child) {
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

// Boots a guest, runs the scenario, and always shuts the machine down.
// Scenarios return plain JSON so specs assert on the result directly.
async function withGuest(scenario) {
  const guest = await spawnGuest();
  try {
    return await scenario(guest);
  } finally {
    guest.machine.close();
    await guest.machine.closed;
  }
}

globalThis.bootSmoke = () =>
  withGuest(async (guest) => {
    const result = await collectProcess(await guest.exec(["uname", "-a"]));
    return { ...result, machineClosed: true };
  });

globalThis.spawnStress = () =>
  withGuest(async (guest) => {
    // One in-guest shell spawning a vfork+exec pair per iteration at full
    // burst rate, with no host round-trip pacing between iterations. This is
    // the workload that exhausts WebKit's shared-memory address-space budget
    // when spawns outpace its asynchronous reservation reclaim: paced
    // spawning passes everywhere, bursts are what break.
    const script = "i=0; while [ $i -lt 100 ]; do ls / >/dev/null || exit 1; i=$((i+1)); done";
    return collectProcess(await guest.exec(["sh", "-c", script]));
  });

globalThis.sharedMemoryGrowProof = async () => {
  const workerURL = URL.createObjectURL(new Blob([growWorkerSource], { type: "text/javascript" }));
  const channel = new MessageChannel();
  const run = (role, port) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(workerURL, { name: role });
      worker.onmessage = ({ data }) => {
        worker.terminate();
        resolve(data);
      };
      worker.onerror = (event) => reject(event.error ?? new Error(event.message));
      worker.postMessage({ port, role }, [port]);
    });

  try {
    const [observer, grower] = await Promise.all([
      run("observer", channel.port1),
      run("grower", channel.port2),
    ]);
    return { observer, grower };
  } finally {
    URL.revokeObjectURL(workerURL);
  }
};

globalThis.schedulerHandoffStress = async () => {
  const response = await fetch("/scheduler-handoff.cpio");
  if (!response.ok) throw new Error(`failed to load scheduler test: ${response.status}`);
  const initcpio = new Uint8Array(await response.arrayBuffer());

  let resolve;
  let reject;
  const completed = new Promise((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  let output = "";
  const decoder = new TextDecoder();
  const consume = (chunk) => {
    // Virtio console output may be a view into shared WebAssembly memory,
    // which TextDecoder deliberately rejects in Chromium and Firefox.
    output += decoder.decode(Uint8Array.from(chunk), { stream: true });
    if (output.includes("::vm-test::pass")) resolve();
    if (output.includes("::vm-test::fail") || output.includes("Kernel panic - not syncing")) {
      reject(new Error(output));
    }
  };
  const outputStream = () =>
    new WritableStream({
      write: consume,
    });
  const input = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  const machine = await spawnMachine({
    cpus: 2,
    devices: [consoleDevice(input, outputStream())],
    initcpio,
  });
  void machine.bootConsole.pipeTo(outputStream()).catch(reject);
  void machine.closed.then(
    () => reject(new Error("machine closed before scheduler handoff test completed")),
    reject,
  );

  try {
    await completed;
  } finally {
    machine.close();
    await machine.closed.catch(() => {});
  }
};
