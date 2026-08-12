import { expect, test } from "@playwright/test";

test("persists a virtio block device through an OPFS worker", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  test.skip(
    !(await page.evaluate(() => "storage" in navigator && "getDirectory" in navigator.storage)),
    "browser does not expose OPFS",
  );
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.opfsWorkerDiskRoundTrip))
    .toBe("function");
  const result = await page.evaluate(() => globalThis.opfsWorkerDiskRoundTrip());

  expect(result.write.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.write.stderr).toBe("");
  expect(result.read.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.read.stderr).toBe("");
  expect(result.read.stdout).toContain(result.marker);
});
