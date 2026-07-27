import { expect, test } from "@playwright/test";

test("reads live process metadata with one logical CPU", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.remoteMemoryMetadata))
    .toBe("function");
  const result = await page.evaluate(() => globalThis.remoteMemoryMetadata());

  expect(result.stderr).toBe("");
  expect(result.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.stdout).toContain("cmdline=sleep 30 ");
  expect(result.stdout).toContain("environ=MARKER=remote-vm-environ");
  expect(result.stdout).toMatch(/auxv=[1-9][0-9]*/);
});

test("cancels and pumps reciprocal remote-memory requests", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.remoteMemoryProtocol))
    .toBe("function");
  await page.evaluate(() => globalThis.remoteMemoryProtocol());
});
