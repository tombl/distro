import { consoleDevice, spawnMachine } from "@tombl/linux";
import { spawnGuest } from "@tombl/linux-guest";
import { VirtioFileSystem } from "@tombl/linux-guest/browser";

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
async function withGuest(scenario, options) {
  const guest = await spawnGuest(options);
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

globalThis.remoteMemoryMetadata = () =>
  withGuest(
    async (guest) => {
      const script = [
        "MARKER=remote-vm-environ sleep 30 &",
        "pid=$!",
        "cmdline=$(tr '\\000' ' ' < /proc/$pid/cmdline)",
        "environ=$(tr '\\000' '\\n' < /proc/$pid/environ)",
        "auxv_size=$(wc -c < /proc/$pid/auxv)",
        "kill $pid",
        "wait $pid 2>/dev/null || true",
        'printf \'cmdline=%s\\nenviron=%s\\nauxv=%s\\n\' "$cmdline" "$(printf \'%s\\n\' "$environ" | grep \'^MARKER=\')" "$auxv_size"',
      ].join("\n");
      return collectProcess(await guest.exec(["sh", "-c", script]));
    },
    { cpus: 1 },
  );

let lifecycleGuest;

globalThis.startRemoteMemoryLifecycle = async () => {
  if (lifecycleGuest) throw new Error("remote-memory lifecycle guest is already running");
  lifecycleGuest = await spawnGuest({ cpus: 1 });
};

globalThis.runRemoteMemoryLifecycleBatch = async (batch, iterations) => {
  if (!lifecycleGuest) throw new Error("remote-memory lifecycle guest is not running");
  const script = [
    "i=0",
    `while [ $i -lt ${iterations} ]; do`,
    `  MARKER=remote-vm-lifecycle-${batch}-$i sleep 30 &`,
    "  pid=$!",
    "  cmdline=$(tr '\\000' ' ' < /proc/$pid/cmdline)",
    "  environ=$(tr '\\000' '\\n' < /proc/$pid/environ | grep '^MARKER=')",
    "  auxv_size=$(wc -c < /proc/$pid/auxv)",
    "  kill $pid",
    "  wait $pid 2>/dev/null || true",
    '  [ "$cmdline" = "sleep 30 " ] || exit 10',
    `  [ "$environ" = "MARKER=remote-vm-lifecycle-${batch}-$i" ] || exit 11`,
    '  [ "$auxv_size" -gt 0 ] || exit 12',
    "  i=$((i+1))",
    "done",
    "printf 'batch=%s processes=%s\\n' \"" + batch + '" "$i"',
  ].join("\n");
  return collectProcess(await lifecycleGuest.exec(["sh", "-c", script]));
};

globalThis.closeRemoteMemoryLifecycle = async () => {
  if (!lifecycleGuest) return;
  const guest = lifecycleGuest;
  lifecycleGuest = undefined;
  guest.machine.close();
  await guest.machine.closed;
};

async function runInitramfs(path, cpus) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`failed to load ${path}: ${response.status}`);
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
    cpus,
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
}

globalThis.schedulerHandoffStress = () => runInitramfs("/scheduler-handoff.cpio", 2);

globalThis.remoteMemoryProtocol = () => runInitramfs("/remote-vm.cpio", 2);

globalThis.opfsVirtioFileSystem = async () => {
  const storage = await navigator.storage.getDirectory();
  await storage.removeEntry("virtio-fs-test", { recursive: true }).catch(() => {});
  const directory = await storage.getDirectoryHandle("virtio-fs-test", { create: true });
  const filesystem = new VirtioFileSystem(directory);
  const created = await filesystem.create(filesystem.root, "hello", 0x40 | 0x80 | 0x2, {
    mode: 0o100640,
    uid: 1000,
    gid: 1000,
  });
  const input = new TextEncoder().encode("persistent");
  await filesystem.write(created.node, created.handle, 0n, input);
  const output = await filesystem.read(created.node, created.handle, 0n, input.length);
  const directoryNode = await filesystem.mkdir(filesystem.root, "directory", {
    mode: 0o040750,
    uid: 1000,
    gid: 1000,
  });
  const nested = await filesystem.create(directoryNode, "nested", 0x40 | 0x80 | 0x2, {
    mode: 0o100600,
    uid: 1000,
    gid: 1000,
  });
  await filesystem.write(nested.node, nested.handle, 0n, new TextEncoder().encode("before"));
  await filesystem.rename(filesystem.root, "directory", filesystem.root, "moved-directory");
  await filesystem.write(nested.node, nested.handle, 0n, new TextEncoder().encode("after"));
  await filesystem.rename(filesystem.root, "hello", filesystem.root, "renamed");
  const entries = (
    await filesystem.readdir(filesystem.root, await filesystem.opendir(filesystem.root))
  )
    .map((entry) => entry.name)
    .sort();

  const reopened = new VirtioFileSystem(directory);
  const node = await reopened.lookup(reopened.root, "renamed");
  const handle = await reopened.open(node, 0);
  const persisted = await reopened.read(node, handle, 0n, input.length);
  const movedDirectory = await reopened.lookup(reopened.root, "moved-directory");
  const nestedNode = await reopened.lookup(movedDirectory, "nested");
  const nestedHandle = await reopened.open(nestedNode, 0);
  const nestedPersisted = await reopened.read(nestedNode, nestedHandle, 0n, 5);
  const stat = await filesystem.getattr(created.node);

  const old = await filesystem.create(filesystem.root, "identity", 0x40 | 0x80 | 0x2, {
    mode: 0o100600,
    uid: 1000,
    gid: 1000,
  });
  await filesystem.write(old.node, old.handle, 0n, new TextEncoder().encode("old"));
  await filesystem.unlink(filesystem.root, "identity");
  const replacement = await filesystem.create(filesystem.root, "identity", 0x40 | 0x80 | 0x2, {
    mode: 0o100600,
    uid: 1000,
    gid: 1000,
  });
  await filesystem.write(replacement.node, replacement.handle, 0n, new TextEncoder().encode("new"));
  await filesystem.write(old.node, old.handle, 0n, new TextEncoder().encode("OLD")).catch(() => {});
  const replacementData = await filesystem.read(replacement.node, replacement.handle, 0n, 3);
  await filesystem.unlink(filesystem.root, "identity");

  const externalOld = await filesystem.create(
    filesystem.root,
    "external-identity",
    0x40 | 0x80 | 0x2,
    { mode: 0o100600, uid: 1000, gid: 1000 },
  );
  await directory.removeEntry("external-identity");
  const missing = await filesystem.lookup(filesystem.root, "external-identity");
  const externalFile = await directory.getFileHandle("external-identity", { create: true });
  const externalWritable = await externalFile.createWritable();
  await externalWritable.write("new");
  await externalWritable.close();
  await filesystem
    .write(externalOld.node, externalOld.handle, 0n, new TextEncoder().encode("OLD"))
    .catch(() => {});
  const externalReplacement = await filesystem.lookup(filesystem.root, "external-identity");
  const externalReplacementHandle = await filesystem.open(externalReplacement, 0);
  const externalReplacementData = await filesystem.read(
    externalReplacement,
    externalReplacementHandle,
    0n,
    3,
  );
  await filesystem.unlink(filesystem.root, "external-identity");

  const renameSource = await filesystem.create(
    filesystem.root,
    "rename-source",
    0x40 | 0x80 | 0x2,
    { mode: 0o100600, uid: 1000, gid: 1000 },
  );
  await filesystem.write(
    renameSource.node,
    renameSource.handle,
    0n,
    new TextEncoder().encode("source"),
  );
  const renameDestination = await filesystem.create(
    filesystem.root,
    "rename-destination",
    0x40 | 0x80 | 0x2,
    { mode: 0o100600, uid: 1000, gid: 1000 },
  );
  await filesystem.write(
    renameDestination.node,
    renameDestination.handle,
    0n,
    new TextEncoder().encode("destination"),
  );
  await filesystem
    .rename(filesystem.root, "rename-source", filesystem.root, "rename-destination")
    .catch(() => {});
  const renameDestinationData = await filesystem.read(
    renameDestination.node,
    renameDestination.handle,
    0n,
    11,
  );
  await filesystem.unlink(filesystem.root, "rename-source");
  await filesystem.unlink(filesystem.root, "rename-destination");
  return {
    entries,
    externalMissing: missing === undefined,
    externalReplacement: new TextDecoder().decode(externalReplacementData),
    mode: stat.mode & 0o777,
    nestedPersisted: new TextDecoder().decode(nestedPersisted),
    output: new TextDecoder().decode(output),
    persisted: new TextDecoder().decode(persisted),
    renameDestination: new TextDecoder().decode(renameDestinationData),
    replacement: new TextDecoder().decode(replacementData),
  };
};
