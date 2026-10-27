import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { blockDevice, bootMachine, diskStorage, type BlockStorage } from "@lowland/kernel";
import type { MachinePlugin } from "@lowland/kernel/plugin";
import {
  guestAgent,
  GuestBootError,
  MountFlags,
  SystemError,
  type GuestAgentOptions,
  type Mount,
} from "../src/index.ts";
import { NodeFS } from "../src/node.ts";
import { ext4_root_mount, ext4_rootfs, root_mount, rootfs } from "./assets.ts";
import { guest_test } from "./fixture.ts";
import { collect } from "./helpers.ts";

async function boot(options: GuestAgentOptions, plugins: readonly MachinePlugin[] = []) {
  const agent = guestAgent(options);
  const machine = await bootMachine({ cpus: 1, plugins: [...plugins, agent] });
  return { agent, machine };
}

async function close(machine: Awaited<ReturnType<typeof bootMachine>>) {
  machine.close();
  await machine.closed;
}

/** A disk with nothing on it. */
function blank_disk(size = 1024 * 1024) {
  return new Uint8Array(size);
}

/** A plugin that attaches each of `disks` with its serial, as another integration would. */
function other_disks(...disks: { serial: string; bytes?: Uint8Array }[]): MachinePlugin {
  return {
    async configure(setup) {
      for (const { serial, bytes = blank_disk(64 * 1024) } of disks) {
        setup.devices.add(blockDevice(await diskStorage(bytes, { writable: true }), { serial }));
      }
    },
  };
}

/** Whether an ext4 image's journal needs recovery: EXT4_FEATURE_INCOMPAT_RECOVER. */
function needs_recovery(disk: Uint8Array) {
  return (new DataView(disk.buffer, disk.byteOffset + 1024).getUint32(0x60, true) & 0x4) !== 0;
}

/** Boots a writable ext4 root, writes to it, and closes without unmounting. */
async function leave_journal_dirty(disk: Uint8Array) {
  const { agent: guest, machine } = await boot({ mounts: [ext4_root_mount(disk)] });
  try {
    await guest.fs.writeTextFile("/unclean-write-test", "journaled\n");
  } finally {
    await close(machine);
  }
  // The machine closes without unmounting, so the journal still needs
  // recovery: EXT4_FEATURE_INCOMPAT_RECOVER in s_feature_incompat.
  const superblock = new DataView(disk.buffer, disk.byteOffset + 1024);
  assert.ok(superblock.getUint32(0x60, true) & 0x4);
}

guest_test("guest", async (t, fixture) => {
  const guest = await fixture.spawn();

  await t.test("configures the network", async () => {
    const network_configuration = await guest.exec(["sh", "-c", "ip address; ip route"]);
    const [output, error, status] = await Promise.all([
      collect(network_configuration.stdout),
      collect(network_configuration.stderr),
      network_configuration.status,
    ]);
    assert.deepEqual(status, { success: true, code: 0, signal: null });
    assert.equal(error.byteLength, 0);
    const configured_network = new TextDecoder().decode(output);
    assert.match(configured_network, /inet 192\.0\.2\.2\/24/);
    assert.match(configured_network, /default via 192\.0\.2\.1 dev eth0/);
  });

  await t.test("runs and collects a command", async () => {
    const result = await guest.run(["sh", "-c", "printf output; printf error >&2; exit 7"]);
    assert.deepEqual(result.status, { success: false, code: 7, signal: null });
    assert.equal(new TextDecoder().decode(result.stdout), "output");
    assert.equal(new TextDecoder().decode(result.stderr), "error");
  });

  await t.test("closes stdin for a collected command", async () => {
    const result = await guest.run(["cat"]);
    assert.deepEqual(result.status, { success: true, code: 0, signal: null });
    assert.equal(result.stdout.byteLength, 0);
    assert.equal(result.stderr.byteLength, 0);
  });

  await t.test("mounts an overlay root over its EROFS image", async () => {
    await guest.fs.writeTextFile("/etc/overlay-write-test", "writable\n");
    assert.equal(await guest.fs.readTextFile("/etc/overlay-write-test"), "writable\n");
    const mounts = await guest.fs.readTextFile("/proc/mounts");
    assert.match(mounts, /^overlay \/ overlay rw/m);
  });

  await t.test("leaves the initramfs behind", async () => {
    await assert.rejects(
      guest.fs.stat("/sysroot"),
      (error) => error instanceof SystemError && error.code === "ENOENT",
    );
    // PID 1 still runs the agent the kernel started, from the deleted /init.
    assert.equal(await guest.fs.readLink("/proc/1/exe"), "/init (deleted)");
    // Every process but PID 1 started in the new root.
    const result = await guest.run(["sh", "-c", "readlink /proc/self/root"]);
    assert.equal(new TextDecoder().decode(result.stdout), "/\n");
  });

  await t.test("mounts devpts", async () => {
    const probe = await guest.exec([
      "sh",
      "-c",
      "test -c /dev/ptmx && grep -q ' /dev/pts devpts ' /proc/mounts",
    ]);
    const [error, status] = await Promise.all([collect(probe.stderr), probe.status]);
    assert.deepEqual(status, { success: true, code: 0, signal: null });
    assert.equal(error.byteLength, 0);
  });

  await t.test("finds its disk by serial", async () => {
    const device = await guest.disk("m0");
    assert.match(device, /^\/dev\/vd[a-z]$/);
    await assert.rejects(
      guest.disk("nonexistent"),
      (error) => error instanceof SystemError && error.code === "ENODEV",
    );
  });
});

test("finds the mount table's disks whatever the device order", async () => {
  const data = new Uint8Array(ext4_rootfs);
  const decoy = blockDevice({
    capacity: rootfs.byteLength,
    read(offset, target) {
      const source = rootfs.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  });
  // Another plugin's disk is the machine's first block device.
  const { agent: guest, machine } = await boot(
    { mounts: [{ path: "/data", source: data, type: "ext4" }, root_mount()] },
    [{ configure: (setup) => setup.devices.add(decoy) }],
  );
  try {
    const mounts = await guest.fs.readTextFile("/proc/mounts");
    assert.match(mounts, /^overlay \/ overlay /m);
    assert.match(mounts, /^\/dev\/vd[a-z] \/data ext4 rw/m);
    // The data disk is the ext4 test system.
    await guest.fs.stat("/data/bin/busybox");
  } finally {
    await close(machine);
  }
});

test("rejects more than one guest agent", async () => {
  await assert.rejects(
    () =>
      bootMachine({
        cpus: 1,
        plugins: [guestAgent({ mounts: [root_mount()] }), guestAgent()],
      }),
    /one guest agent/,
  );
});

test("checks the mount table when the agent is created", () => {
  assert.throws(() => guestAgent({ mounts: [root_mount(), ext4_root_mount()] }), {
    name: "TypeError",
    message: "only one mount can be at /",
  });
  assert.throws(() => guestAgent({ mounts: [{ path: "data", type: "tmpfs" }] }), TypeError);
  assert.throws(() => guestAgent({ mounts: [{ path: "/a/../b", type: "tmpfs" }] }), TypeError);
  assert.throws(() => guestAgent({ mounts: [{ path: "/data" }] }), /needs a source or a type/);
  assert.throws(
    () => guestAgent({ mounts: [{ ...root_mount(), mode: "rx" as "rw" }] }),
    /mount mode/,
  );
  assert.throws(() => guestAgent({ init: ["/sbin/init"] }), /init needs a mount at \//);
  assert.throws(() => guestAgent({ mounts: [root_mount()], init: [] }), /init must be/);
});

test("stays on its initramfs without a root", async () => {
  const { agent: guest, machine } = await boot({
    mounts: [{ path: "/scratch", type: "tmpfs", options: "size=1m" }],
  });
  try {
    // The agent is still /init, and the initramfs has nothing else to run.
    assert.equal((await guest.fs.stat("/init")).isFile, true);
    await assert.rejects(
      guest.exec(["sh"]),
      (error) => error instanceof SystemError && error.code === "ENOENT",
    );
    assert.match(await guest.fs.readTextFile("/proc/mounts"), /^tmpfs \/scratch tmpfs rw/m);
  } finally {
    await close(machine);
  }
});

test("keeps writes to a writable ext4 root", async () => {
  const disk = new Uint8Array(ext4_rootfs);
  {
    const { agent: guest, machine } = await boot({ mounts: [ext4_root_mount(disk)] });
    try {
      await guest.fs.writeTextFile("/persistent-write-test", "writable\n");
      assert.match(await guest.fs.readTextFile("/proc/mounts"), /^\/dev\/vda \/ ext4 rw/m);
      await guest.fs.sync();
    } finally {
      await close(machine);
    }
  }
  const { agent: guest, machine } = await boot({ mounts: [ext4_root_mount(disk)] });
  try {
    assert.equal(await guest.fs.readTextFile("/persistent-write-test"), "writable\n");
  } finally {
    await close(machine);
  }
});

test("discards writes to an overlay root", async () => {
  const disk = new Uint8Array(ext4_rootfs);
  const original = disk.slice();
  for (let boots = 0; boots < 2; boots++) {
    const { agent: guest, machine } = await boot({
      mounts: [ext4_root_mount(disk, "overlay")],
    });
    try {
      await assert.rejects(
        guest.fs.stat("/etc/overlay-write-test"),
        (error) => error instanceof SystemError && error.code === "ENOENT",
      );
      await guest.fs.writeTextFile("/etc/overlay-write-test", "writable\n");
      assert.match(await guest.fs.readTextFile("/proc/mounts"), /^overlay \/ overlay rw/m);
      await guest.fs.sync();
    } finally {
      await close(machine);
    }
  }
  assert.deepEqual(disk, original);
});

test("mounts a read-only root read-only", async () => {
  const disk = new Uint8Array(ext4_rootfs);
  const original = disk.slice();
  const { agent: guest, machine } = await boot({ mounts: [ext4_root_mount(disk, "ro")] });
  try {
    assert.match(await guest.fs.readTextFile("/proc/mounts"), /^\/dev\/vda \/ ext4 ro/m);
    await assert.rejects(
      guest.fs.writeTextFile("/read-only-write-test", "x"),
      (error) => error instanceof SystemError && error.code === "EROFS",
    );
  } finally {
    await close(machine);
  }
  assert.deepEqual(disk, original);
});

test("mounts a shared directory as an overlay's lower layer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "guest-share-overlay-"));
  try {
    await writeFile(join(directory, "host.txt"), "from the host\n");
    const { agent: guest, machine } = await boot({
      mounts: [root_mount(), { path: "/share", source: new NodeFS(directory), mode: "overlay" }],
    });
    try {
      assert.equal(await guest.fs.readTextFile("/share/host.txt"), "from the host\n");
      await guest.fs.writeTextFile("/share/host.txt", "from the guest\n");
      await guest.fs.writeTextFile("/share/guest.txt", "new\n");
      assert.equal(await guest.fs.readTextFile("/share/host.txt"), "from the guest\n");
      assert.match(await guest.fs.readTextFile("/proc/mounts"), /^overlay \/share overlay rw/m);
    } finally {
      await close(machine);
    }
    assert.equal(await readFile(join(directory, "host.txt"), "utf8"), "from the host\n");
    await assert.rejects(readFile(join(directory, "guest.txt")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tries each block filesystem for a disk without a type", async () => {
  const data = new Uint8Array(ext4_rootfs);
  const { agent: guest, machine } = await boot({
    mounts: [root_mount(), { path: "/data", source: data, mode: "ro" }],
  });
  try {
    assert.match(await guest.fs.readTextFile("/proc/mounts"), /^\/dev\/vd[a-z] \/data ext4 ro/m);
  } finally {
    await close(machine);
  }
});

test("reports every filesystem it tried for a disk with none", async () => {
  await assert.rejects(
    boot({ mounts: [root_mount(), { path: "/data", source: blank_disk() }] }),
    (error) => {
      assert(error instanceof GuestBootError);
      assert.equal(error.step, "mounting m1 (1048576 bytes) at /data");
      assert(error.cause instanceof SystemError);
      assert.match(
        error.message,
        /^mounting m1 \(1048576 bytes\) at \/data: E\w+ \(tried .*ext4: E\w+/,
      );
      return true;
    },
  );
});

test("fails to mount a dirty ext4 journal on read-only storage", async () => {
  const disk = new Uint8Array(ext4_rootfs);
  await leave_journal_dirty(disk);
  const dirty = disk.slice();
  for (const mode of ["ro", "overlay"] as const) {
    await assert.rejects(boot({ mounts: [ext4_root_mount(disk, mode)] }), (error) => {
      assert(error instanceof GuestBootError);
      assert.equal(error.step, `mounting m0 (${disk.byteLength} bytes) at /`);
      assert(error.cause instanceof SystemError);
      assert.equal(error.cause.code, "EROFS");
      // The kernel's own words, from the end of its log.
      assert.match(error.kernelLog, /write access unavailable, cannot proceed/);
      return true;
    });
  }
  // Read-only storage was never written, so the journal is still there.
  assert.deepEqual(disk, dirty);
  // A writable root replays it.
  const { agent: guest, machine } = await boot({ mounts: [ext4_root_mount(disk)] });
  try {
    assert.equal(await guest.fs.readTextFile("/unclean-write-test"), "journaled\n");
  } finally {
    await close(machine);
  }
});

test("powering off unmounts every filesystem, however many there are", async () => {
  const data = new Uint8Array(ext4_rootfs);
  const { agent: guest, machine } = await boot({ mounts: [root_mount()] }, [
    other_disks({ serial: "data", bytes: data }),
  ]);
  try {
    const device = await guest.disk("data");
    // The data disk comes last, after more mounts than a fixed-size table
    // would hold.
    const result = await guest.run([
      "sh",
      "-c",
      `for i in $(seq 300); do mkdir -p /t/$i && mount -t tmpfs t /t/$i || exit 1; done
       mkdir /data && mount -t ext4 ${device} /data && echo kept > /data/marker && grep -c . /proc/mounts`,
    ]);
    assert.equal(result.status.success, true, new TextDecoder().decode(result.stderr));
    assert.ok(Number(new TextDecoder().decode(result.stdout)) > 300);
    assert.equal(needs_recovery(data), true);
    // BusyBox poweroff's signal. It ends this session, so the kill may not
    // get to report back.
    await guest.run(["kill", "-USR2", "1"]).catch(() => {});
    await machine.closed;
  } catch (error) {
    await close(machine);
    throw error;
  }
  assert.equal(needs_recovery(data), false);
  const { agent: reader, machine: second } = await boot({
    mounts: [root_mount(), { path: "/data", source: data, type: "ext4", mode: "ro" }],
  });
  try {
    assert.equal(await reader.fs.readTextFile("/data/marker"), "kept\n");
  } finally {
    await close(second);
  }
});

test("finds disks by their exact serials", async () => {
  const { agent: guest, machine } = await boot({ mounts: [root_mount()] }, [
    other_disks(
      { serial: "data disk" },
      { serial: "data disk " },
      { serial: " data disk" },
      { serial: "twin" },
      { serial: "twin" },
    ),
  ]);
  try {
    const devices = await Promise.all(
      ["data disk", "data disk ", " data disk"].map((serial) => guest.disk(serial)),
    );
    assert.equal(new Set(devices).size, 3);
    // The kernel reports the serial as it is: spaces kept, no newline.
    const name = devices[1]!.slice("/dev/".length);
    assert.equal(await guest.fs.readTextFile(`/sys/block/${name}/serial`), "data disk ");
    await assert.rejects(guest.disk("twin"), /more than one disk has the serial "twin"/);
    await assert.rejects(
      guest.disk("data"),
      (error) => error instanceof SystemError && error.code === "ENODEV",
    );
  } finally {
    await close(machine);
  }
});

test("rejects a mount table disk whose serial another disk shares", async () => {
  await assert.rejects(
    boot({ mounts: [root_mount(), { path: "/data", source: blank_disk(), type: "ext4" }] }, [
      other_disks({ serial: "m1" }),
    ]),
    (error) =>
      error instanceof GuestBootError &&
      error.step === "mounting m1 (1048576 bytes) at /data" &&
      /more than one disk has the serial "m1"/.test(error.message),
  );
});

test("runs a custom boot", async () => {
  const steps: string[] = [];
  const { agent: guest, machine } = await boot({
    mounts: [{ path: "/", source: rootfs, mode: "ro" }],
    async boot(guest) {
      await guest.fs.mkdir("/proc");
      await guest.mount("proc", "/proc", { type: "proc" });
      await guest.fs.mkdir("/sys");
      await guest.mount("sysfs", "/sys", { type: "sysfs" });
      const device = await guest.disk("m0");
      steps.push(device);
      await guest.fs.mkdir("/sysroot");
      await guest.mount(device, "/sysroot", { type: "erofs", flags: MountFlags.RDONLY });
      await guest.mount("tmpfs", "/sysroot/tmp", { type: "tmpfs" });
      for (const name of ["dev", "proc", "sys"]) {
        await guest.mount(`/${name}`, `/sysroot/${name}`, { flags: MountFlags.MOVE });
      }
      await guest.switchRoot();
      steps.push(await guest.fs.readTextFile("/proc/mounts"));
      await assert.rejects(guest.switchRoot(), /already switched root/);
    },
  });
  try {
    assert.match(steps[0]!, /^\/dev\/vd[a-z]$/);
    assert.match(steps[1]!, /^\/dev\/vd[a-z] \/ erofs ro/m);
    assert.match(steps[1]!, /^tmpfs \/tmp tmpfs rw/m);
    const result = await guest.run(["sh", "-c", "echo booted > /tmp/custom && cat /tmp/custom"]);
    assert.equal(new TextDecoder().decode(result.stdout), "booted\n");
  } finally {
    await close(machine);
  }
});

test("reports a switch into something that is not a root", async () => {
  await assert.rejects(
    boot({
      async boot(guest) {
        await guest.fs.mkdir("/sysroot");
        await guest.mount("tmpfs", "/sysroot", { type: "tmpfs" });
        // /sysroot/dev, /sysroot/proc, and /sysroot/sys are not mount points.
        await guest.switchRoot();
      },
    }),
    (error) =>
      error instanceof GuestBootError &&
      error.step === "switching root" &&
      error.cause instanceof SystemError &&
      error.cause.code === "ENOENT",
  );
});

test("init runs as PID 1's child, and its exit powers off cleanly", async () => {
  const disk = new Uint8Array(ext4_rootfs);
  const { agent: guest, machine } = await boot({
    mounts: [ext4_root_mount(disk)],
    // As the kernel's /init, it leads no process group, so setsid(1) runs
    // in place rather than forking a child and exiting.
    init: ["setsid", "sh", "-c", 'echo "$$ $PPID" > /run/init; touch /init-wrote; exec sleep 600'],
  });
  let pid: string | undefined;
  try {
    for (let attempt = 0; !pid && attempt < 200; attempt++) {
      try {
        pid = (await guest.fs.readTextFile("/run/init")).split(" ")[0];
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(pid, "init did not start");
    assert.match(await guest.fs.readTextFile(`/proc/${pid}/status`), /^PPid:\s+1$/m);
    assert.equal((await guest.fs.readTextFile(`/proc/${pid}/stat`)).split(" ")[5], pid);
    // The init's exit is the machine's power-off, which also ends this
    // session, so the kill may not get to report back.
    await guest.run(["kill", pid]).catch(() => {});
    await machine.closed;
  } catch (error) {
    await close(machine);
    throw error;
  }
  // The agent unmounted the root before powering off, so the journal is
  // clean and read-only storage mounts it.
  const superblock = new DataView(disk.buffer, disk.byteOffset + 1024);
  assert.equal(superblock.getUint32(0x60, true) & 0x4, 0);
  const { agent: reader, machine: second } = await boot({ mounts: [ext4_root_mount(disk, "ro")] });
  try {
    await reader.fs.stat("/init-wrote");
  } finally {
    await close(second);
  }
});

test("reports an init that cannot start", async () => {
  await assert.rejects(
    boot({ mounts: [root_mount()], init: ["/no/such/init"] }),
    (error) => error instanceof GuestBootError && error.step === "switching root",
  );
});

test("closing before the agent is ready does not wait for it", async () => {
  let machine_closed: Promise<void> | undefined;
  const closer: MachinePlugin = {
    configure() {},
    booted(machine) {
      machine_closed = machine.closed;
      setTimeout(() => machine.close(), 0);
    },
  };
  await assert.rejects(
    bootMachine({ cpus: 1, plugins: [closer, guestAgent({ mounts: [ext4_root_mount()] })] }),
    /machine closed before guest agent became ready/,
  );
  assert(machine_closed);
  await machine_closed;
});

async function read_back(disk: Uint8Array<ArrayBuffer>) {
  const { agent: guest, machine } = await boot({ mounts: [ext4_root_mount(disk)] });
  try {
    return await guest.fs.readTextFile("/close-sync-test");
  } finally {
    await close(machine);
  }
}

test("closing the machine keeps writes to an ext4 root", async (t) => {
  await t.test("with close()", async () => {
    const disk = new Uint8Array(ext4_rootfs);
    const { agent: guest, machine } = await boot({ mounts: [ext4_root_mount(disk)] });
    await guest.fs.writeTextFile("/close-sync-test", "closed\n");
    await close(machine);
    assert.equal(await read_back(disk), "closed\n");
  });

  await t.test("with await using", async () => {
    const disk = new Uint8Array(ext4_rootfs);
    {
      const guest = guestAgent({ mounts: [ext4_root_mount(disk)] });
      await using _machine = await bootMachine({ cpus: 1, plugins: [guest] });
      await guest.fs.writeTextFile("/close-sync-test", "disposed\n");
    }
    assert.equal(await read_back(disk), "disposed\n");
  });

  await t.test("from a closing hook listed after the agent", async () => {
    const disk = new Uint8Array(ext4_rootfs);
    const guest = guestAgent({ mounts: [ext4_root_mount(disk)] });
    const late_writer: MachinePlugin = {
      configure() {},
      async closing() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await guest.fs.writeTextFile("/close-sync-test", "late\n");
      },
    };
    const machine = await bootMachine({ cpus: 1, plugins: [guest, late_writer] });
    await close(machine);
    assert.equal(await read_back(disk), "late\n");
  });
});

test("a sync stuck in host storage forces teardown", async () => {
  const disk = new Uint8Array(ext4_rootfs);
  const stuck = Promise.withResolvers<void>();
  let hang = false;
  const storage: BlockStorage = {
    capacity: disk.byteLength,
    read(offset, target) {
      const source = disk.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
    write(offset, data) {
      disk.set(data, offset);
      return data.byteLength;
    },
    flush() {
      if (hang) return stuck.promise;
    },
  };
  const root: Mount = { path: "/", source: storage, type: "ext4" };
  const guest = guestAgent({ mounts: [root], syncTimeoutMs: 1000 });
  const machine = await bootMachine({ cpus: 1, plugins: [guest] });
  await guest.fs.writeTextFile("/close-sync-test", "stuck\n");
  hang = true;
  machine.close();
  await assert.rejects(machine.closed, /did not sync its filesystems/);

  // The abandoned flush failing later reaches the finished machine as a no-op.
  stuck.reject(new Error("late flush failure"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(machine.closed, /did not sync its filesystems/);
});
