import { expect, test } from "./opfs.ts";

test("persists a virtio block device through an OPFS worker", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  test.skip(
    !(await page.evaluate(() => "storage" in navigator && "getDirectory" in navigator.storage)),
    "browser does not expose OPFS",
  );
  await expect
    .poll(() => page.evaluate(() => typeof window.opfsWorkerDiskRoundTrip))
    .toBe("function");
  const result = await page.evaluate(() => window.opfsWorkerDiskRoundTrip());

  expect(result.write.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.write.stderr).toBe("");
  expect(result.read.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.read.stderr).toBe("");
  expect(result.read.stdout).toContain(result.marker);
});

test("reports an OPFS disk that is already open with the browser's error", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  test.skip(
    !(await page.evaluate(() => "storage" in navigator && "getDirectory" in navigator.storage)),
    "browser does not expose OPFS",
  );
  await expect.poll(() => page.evaluate(() => typeof window.opfsWorkerDiskLocked)).toBe("function");
  const result = await page.evaluate(() => window.opfsWorkerDiskLocked());

  expect(result.rejected).toBe(true);
  // The spec's name for a file another handle holds; WebKit since build 2370
  // (Playwright 1.64) says InvalidStateError.
  expect(["NoModificationAllowedError", "InvalidStateError"]).toContain(result.name);
  expect(result.message).not.toBe("");
  expect(result.message).not.toMatch(/^Uncaught/);
});
