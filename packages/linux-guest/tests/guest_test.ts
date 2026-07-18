import assert from "node:assert/strict";
import { SystemError } from "../src/index.ts";
import { guest_test } from "./fixture.ts";
import { collect } from "./helpers.ts";

guest_test("guest", async (t, fixture) => {
  const guest = await fixture.spawn();

  await t.step("configures the network", async () => {
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

  await t.step("mounts the root filesystem read-only", async () => {
    await assert.rejects(
      guest.fs.writeTextFile("/immutable.txt", "nope"),
      (error) => error instanceof SystemError && error.code === "EROFS",
    );
  });
});
