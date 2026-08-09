import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice, spawnGuest, SystemError } from "../src/index.ts";
import { ext4_root_device, root_device, wrong_root_device } from "./assets.ts";
import { guest_test } from "./fixture.ts";
import { collect } from "./helpers.ts";

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

  await t.test("mounts the root filesystem read-only", async () => {
    await assert.rejects(
      guest.fs.writeTextFile("/immutable.txt", "nope"),
      (error) => error instanceof SystemError && error.code === "EROFS",
    );
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

guest_test("temporary root overlay", async (_t, fixture) => {
  const guest = await fixture.spawn([], { cmdline: "lowland.root.overlay=tmpfs" });
  await guest.fs.writeTextFile("/overlay-write-test", "writable\n");
  assert.equal(await guest.fs.readTextFile("/overlay-write-test"), "writable\n");

  const probe = await guest.exec([
    "sh",
    "-c",
    "grep -q ' / overlay ' /proc/mounts && ! test -e /bin/linux-guest-agent && ! grep -q ' /mnt ' /proc/mounts",
  ]);
  const [error, status] = await Promise.all([collect(probe.stderr), probe.status]);
  assert.deepEqual(status, { success: true, code: 0, signal: null });
  assert.equal(error.byteLength, 0);
});

test("rejects more than one system disk", async () => {
  await assert.rejects(() =>
    spawnGuest({
      cpus: 1,
      root: root_device(),
      devices: [root_device()],
    }),
  );
});

test("boots a writable ext4 system disk", async () => {
  const guest = await spawnGuest({ cpus: 1, root: ext4_root_device() });
  try {
    await guest.fs.writeTextFile("/persistent-write-test", "writable\n");
    assert.equal(await guest.fs.readTextFile("/persistent-write-test"), "writable\n");
    const probe = await guest.exec(["sh", "-c", "grep -q ' / ext4 rw' /proc/mounts"]);
    assert.deepEqual(await probe.status, { success: true, code: 0, signal: null });
  } finally {
    guest.machine.close();
    await guest.machine.closed;
  }
});

test("rejects a system disk with the wrong label", async () => {
  await assert.rejects(() => spawnGuest({ cpus: 1, root: wrong_root_device() }));
});

test("rejects a system disk without a label", async () => {
  const empty = new Uint8Array(4096);
  await assert.rejects(() =>
    spawnGuest({
      cpus: 1,
      root: blockDevice({
        capacity: empty.byteLength,
        read(offset, length) {
          return empty.subarray(offset, offset + length);
        },
      }),
    }),
  );
});
