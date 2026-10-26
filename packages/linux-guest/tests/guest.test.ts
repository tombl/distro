import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice, bootMachine, type VsockDevice, vsockDevice } from "@lowland/kernel";
import type { MachinePlugin } from "@lowland/kernel/plugin";
import { GuestSession } from "../src/conn.ts";
import { GuestBootError, guestAgent, ProtocolError, SystemError } from "../src/index.ts";
import {
  agent_device,
  ext4_root_device,
  ext4_rootfs,
  readonly_ext4_root_device,
  root_device,
  wrong_root_device,
} from "./assets.ts";
import { guest_test } from "./fixture.ts";
import { collect } from "./helpers.ts";

async function boot(
  root: ReturnType<typeof root_device>,
  extra = [] as ReturnType<typeof root_device>[],
) {
  const agent = guestAgent();
  const machine = await bootMachine({ cpus: 1, plugins: [root, ...extra, agent] });
  return { agent, machine };
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

  await t.test("mounts an EROFS root beneath a writable overlay", async () => {
    await guest.fs.writeTextFile("/etc/overlay-write-test", "writable\n");
    assert.equal(await guest.fs.readTextFile("/etc/overlay-write-test"), "writable\n");
    const probe = await guest.exec(["sh", "-c", "grep -q ' / overlay ' /proc/mounts"]);
    const [error, status] = await Promise.all([collect(probe.stderr), probe.status]);
    assert.deepEqual(status, { success: true, code: 0, signal: null });
    assert.equal(error.byteLength, 0);
  });

  await t.test("hides the agent filesystem after pivot_root", async () => {
    await assert.rejects(
      guest.fs.stat("/bin/linux-guest-agent"),
      (error) => error instanceof SystemError && error.code === "ENOENT",
    );
    const probe = await guest.exec([
      "sh",
      "-c",
      "! grep -q ' /mnt ' /proc/mounts && readlink /proc/1/exe | grep -q linux-guest-agent",
    ]);
    const [error, status] = await Promise.all([collect(probe.stderr), probe.status]);
    assert.deepEqual(status, { success: true, code: 0, signal: null });
    assert.equal(error.byteLength, 0);
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
});

guest_test("root discovery", async (_t, fixture) => {
  const guest = await fixture.spawn([wrong_root_device()]);
  const command = await guest.exec(["uname", "-s"]);
  const [output, status] = await Promise.all([collect(command.stdout), command.status]);
  assert.equal(new TextDecoder().decode(output).trim(), "Linux");
  assert.deepEqual(status, { success: true, code: 0, signal: null });
});

function boot_failure(message: string) {
  return (error: unknown) => error instanceof GuestBootError && error.message === message;
}

const no_root = boot_failure("no supported filesystem is labeled LOWLAND_ROOT");

// The agent waits only for disks the device tree promises, so a missing root
// is reported about as fast as a successful boot. The bound is loose enough
// for a loaded CI machine but well below the old ten second poll.
async function rejects_promptly(boot: () => Promise<unknown>) {
  const started = performance.now();
  await assert.rejects(boot, no_root);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `rejected after ${Math.round(elapsed)}ms`);
}

function blank_device() {
  const empty = new Uint8Array(4096);
  return blockDevice({
    capacity: empty.byteLength,
    read(offset, target) {
      const source = empty.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  });
}

test("rejects a machine without a system disk", async () => {
  await rejects_promptly(() => bootMachine({ cpus: 1, plugins: [guestAgent()] }));
});

test("rejects several disks without a system disk", async () => {
  await rejects_promptly(() => boot(wrong_root_device(), [blank_device(), blank_device()]));
});

test("finds the system disk among several disks", async () => {
  const { agent: guest, machine } = await boot(blank_device(), [
    wrong_root_device(),
    root_device(),
    blank_device(),
  ]);
  try {
    const result = await guest.run(["uname", "-s"]);
    assert.equal(new TextDecoder().decode(result.stdout).trim(), "Linux");
  } finally {
    machine.close();
    await machine.closed;
  }
});

test("rejects more than one system disk", async () => {
  await assert.rejects(
    () => boot(root_device(), [root_device()]),
    boot_failure("multiple filesystems are labeled LOWLAND_ROOT"),
  );
});

test("rejects more than one guest agent", async () => {
  await assert.rejects(
    () =>
      bootMachine({
        cpus: 1,
        plugins: [root_device(), guestAgent(), guestAgent()],
      }),
    /one guest agent/,
  );
});

test("boots a writable ext4 system disk", async () => {
  const disk = new Uint8Array(ext4_rootfs);
  {
    const { agent: guest, machine } = await boot(ext4_root_device(disk));
    try {
      await guest.fs.writeTextFile("/persistent-write-test", "writable\n");
      assert.equal(await guest.fs.readTextFile("/persistent-write-test"), "writable\n");
      const probe = await guest.exec(["sh", "-c", "grep -q ' / ext4 rw' /proc/mounts && sync"]);
      assert.deepEqual(await probe.status, { success: true, code: 0, signal: null });
    } finally {
      machine.close();
      await machine.closed;
    }
  }
  const { agent: guest, machine } = await boot(ext4_root_device(disk));
  try {
    assert.equal(await guest.fs.readTextFile("/persistent-write-test"), "writable\n");
  } finally {
    machine.close();
    await machine.closed;
  }
});

test("boots a read-only ext4 system disk beneath a writable overlay", async () => {
  const original = new Uint8Array(ext4_rootfs);
  const { agent: guest, machine } = await boot(readonly_ext4_root_device());
  try {
    await guest.fs.writeTextFile("/etc/overlay-write-test", "writable\n");
    assert.equal(await guest.fs.readTextFile("/etc/overlay-write-test"), "writable\n");
    const probe = await guest.exec(["sh", "-c", "grep -q ' / overlay ' /proc/mounts && sync"]);
    assert.deepEqual(await probe.status, { success: true, code: 0, signal: null });
  } finally {
    machine.close();
    await machine.closed;
  }
  assert.ok(ext4_rootfs.equals(original));
});

test("boots an uncleanly closed ext4 system disk read-only", async () => {
  const disk = new Uint8Array(ext4_rootfs);
  {
    const { agent: guest, machine } = await boot(ext4_root_device(disk));
    try {
      await guest.fs.writeTextFile("/unclean-write-test", "journaled\n");
      const probe = await guest.exec(["sync"]);
      assert.deepEqual(await probe.status, { success: true, code: 0, signal: null });
    } finally {
      machine.close();
      await machine.closed;
    }
  }
  // The machine closes without unmounting, so the journal still needs
  // recovery: EXT4_FEATURE_INCOMPAT_RECOVER in s_feature_incompat.
  const superblock = new DataView(disk.buffer, disk.byteOffset + 1024);
  assert.ok(superblock.getUint32(0x60, true) & 0x4);
  const original = disk.slice();
  const { agent: guest, machine } = await boot(readonly_ext4_root_device(disk));
  try {
    const probe = await guest.exec(["sh", "-c", "grep -q ' / overlay ' /proc/mounts"]);
    assert.deepEqual(await probe.status, { success: true, code: 0, signal: null });
    // Without journal replay the root is as of the last checkpoint, which
    // the write may not have reached yet.
    const exists = await guest.exec(["test", "-e", "/unclean-write-test"]);
    const visible = (await exists.status).success;
    if (visible) assert.equal(await guest.fs.readTextFile("/unclean-write-test"), "journaled\n");
    console.log(`journaled write visible read-only: ${visible}`);
  } finally {
    machine.close();
    await machine.closed;
  }
  assert.deepEqual(disk, original);
});

async function read_back(disk: Uint8Array<ArrayBuffer>) {
  const { agent: guest, machine } = await boot(ext4_root_device(disk));
  try {
    return await guest.fs.readTextFile("/close-sync-test");
  } finally {
    machine.close();
    await machine.closed;
  }
}

test("closing the machine keeps writes to an ext4 system disk", async (t) => {
  await t.test("with close()", async () => {
    const disk = new Uint8Array(ext4_rootfs);
    const { agent: guest, machine } = await boot(ext4_root_device(disk));
    await guest.fs.writeTextFile("/close-sync-test", "closed\n");
    machine.close();
    await machine.closed;
    assert.equal(await read_back(disk), "closed\n");
  });

  await t.test("with await using", async () => {
    const disk = new Uint8Array(ext4_rootfs);
    {
      const guest = guestAgent();
      await using _machine = await bootMachine({
        cpus: 1,
        plugins: [ext4_root_device(disk), guest],
      });
      await guest.fs.writeTextFile("/close-sync-test", "disposed\n");
    }
    assert.equal(await read_back(disk), "disposed\n");
  });

  await t.test("from a closing hook listed after the agent", async () => {
    const disk = new Uint8Array(ext4_rootfs);
    const guest = guestAgent();
    const late_writer: MachinePlugin = {
      configure() {},
      async closing() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await guest.fs.writeTextFile("/close-sync-test", "late\n");
      },
    };
    const machine = await bootMachine({
      cpus: 1,
      plugins: [ext4_root_device(disk), guest, late_writer],
    });
    machine.close();
    await machine.closed;
    assert.equal(await read_back(disk), "late\n");
  });
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
    bootMachine({ cpus: 1, plugins: [ext4_root_device(), closer, guestAgent()] }),
    /machine closed before guest agent became ready/,
  );
  assert(machine_closed);
  await machine_closed;
});

test("a sync stuck in host storage forces teardown", async () => {
  const disk = new Uint8Array(ext4_rootfs);
  const stuck = Promise.withResolvers<void>();
  let hang = false;
  const root = blockDevice({
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
  });
  const guest = guestAgent({ syncTimeoutMs: 1000 });
  const machine = await bootMachine({ cpus: 1, plugins: [root, guest] });
  await guest.fs.writeTextFile("/close-sync-test", "stuck\n");
  hang = true;
  machine.close();
  await assert.rejects(machine.closed, /did not sync its filesystems/);

  // The abandoned flush failing later reaches the finished machine as a no-op.
  stuck.reject(new Error("late flush failure"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(machine.closed, /did not sync its filesystems/);
});

test("rejects a system disk with the wrong label", async () => {
  await rejects_promptly(() => boot(wrong_root_device()));
});

test("rejects a system disk without a label", async () => {
  await rejects_promptly(() => boot(blank_device()));
});

// Boots the pristine ext4 root beside a blank disk, copies the root onto that
// disk, and runs `script` in the copy. The copy is mounted only once, so even
// directories that are mountpoints in the running system can be removed.
async function broken_root(script: string) {
  const copy = new Uint8Array(ext4_rootfs.byteLength);
  const { agent, machine } = await boot(ext4_root_device(), [ext4_root_device(copy)]);
  try {
    const result = await agent.run([
      "sh",
      "-ec",
      `root=$(awk '$2 == "/" { print $1 }' /proc/mounts)
      for disk in /dev/vd[a-z]; do
        [ "$disk" = "$root" ] || [ -e "\${disk}1" ] || target=$disk
      done
      sync
      dd if="$root" of="$target" bs=1M 2>/dev/null
      mkdir /tmp/copy
      mount -t ext4 "$target" /tmp/copy
      cd /tmp/copy
      ${script}
      cd /
      umount /tmp/copy
      sync`,
    ]);
    assert.deepEqual(
      result.status,
      { success: true, code: 0, signal: null },
      new TextDecoder().decode(result.stderr),
    );
  } finally {
    machine.close();
    await machine.closed;
  }
  return ext4_root_device(copy);
}

test("reports a system root that fails to mount", async () => {
  await assert.rejects(
    () => boot(ext4_root_device(new Uint8Array(ext4_rootfs.subarray(0, 64 * 1024)))),
    (error) =>
      error instanceof GuestBootError &&
      /^mounting system root \/dev\/vd[a-z]: /.test(error.message),
  );
});

test("reports a system root without a mountpoint for /run", async () => {
  const root = await broken_root("rm -rf run");
  await assert.rejects(
    () => boot(root),
    boot_failure("mounting system root tmpfs: No such file or directory"),
  );
});

test("reports a system root that cannot be entered", async () => {
  const root = await broken_root("rmdir dev");
  await assert.rejects(
    () => boot(root),
    boot_failure("entering system root: No such file or directory"),
  );
});

test("reports a system init that cannot start", async () => {
  const root = await broken_root("printf '#!/missing-interpreter\\n' >init; chmod 755 init");
  await assert.rejects(
    () => boot(root),
    boot_failure("starting system init: No such file or directory"),
  );
});

test("a stalled client does not hide the boot failure from the next", async () => {
  const vsock = vsockDevice();
  const machine = await bootMachine({
    cpus: 1,
    args: ["root=PARTLABEL=LOWLAND_AGENT", "rootfstype=erofs", "ro", "rootwait", "init=/init"],
    plugins: [agent_device(), vsock],
  });
  try {
    let stalled: Awaited<ReturnType<VsockDevice["connect"]>> | undefined;
    const deadline = Date.now() + 30_000;
    while (!stalled) {
      try {
        stalled = await vsock.connect(1024, { timeoutMs: 1000 });
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      // One byte of a handshake, then silence, with the connection held open.
      await stalled.write(new Uint8Array([0x54]));
      const started = performance.now();
      await assert.rejects(GuestSession.connect(vsock, { timeoutMs: 5000 }), no_root);
      assert.ok(performance.now() - started < 5000);
      assert.equal((await stalled.read()).byteLength, 0);
    } finally {
      stalled.close();
    }
  } finally {
    machine.close();
    await machine.closed;
  }
});

test("rejects a truncated boot failure diagnostic", async () => {
  const replies = [new Uint8Array([0x54, 0x4c, 0x4e, 0x58, 4, 0, 10, 0]), new Uint8Array(3)];
  let closed = false;
  const connection = {
    async write() {},
    async readExactly() {
      return replies.shift()!;
    },
    close() {
      closed = true;
    },
  };
  const device = { connect: async () => connection } as unknown as VsockDevice;
  await assert.rejects(GuestSession.connect(device), (error) => {
    return error instanceof ProtocolError && /closed during handshake/.test(error.message);
  });
  assert.ok(closed);
});
