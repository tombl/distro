import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice, bootMachine } from "@lowland/kernel";
import { guestAgent, SystemError } from "../src/index.ts";
import {
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

test("rejects more than one system disk", async () => {
  await assert.rejects(() => boot(root_device(), [root_device()]));
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

test("rejects a system disk with the wrong label", async () => {
  await assert.rejects(() => boot(wrong_root_device()));
});

test("rejects a system disk without a label", async () => {
  const empty = new Uint8Array(4096);
  await assert.rejects(() =>
    boot(
      blockDevice({
        capacity: empty.byteLength,
        read(offset, target) {
          const source = empty.subarray(offset, offset + target.byteLength);
          target.set(source);
          return source.byteLength;
        },
      }),
    ),
  );
});
