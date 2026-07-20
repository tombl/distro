import { consoleDevice, spawnMachine } from "@tombl/linux";
import { spawnGuest } from "@tombl/linux-guest";

async function collectProcess(child) {
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

globalThis.bootSmoke = async () => {
  const guest = await spawnGuest();
  let result;
  try {
    result = await collectProcess(await guest.exec(["uname", "-a"]));
  } finally {
    guest.machine.close();
    await guest.machine.closed;
  }
  return { ...result, machineClosed: true };
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
