import { expect, test } from "@playwright/test";

test("boots the packaged guest, runs uname, and closes cleanly", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => typeof globalThis.bootSmoke)).toBe("function");
  const result = await page.evaluate(() => globalThis.bootSmoke());

  expect(result.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Linux");
  expect(result.machineClosed).toBe(true);
});

test("hands CPUs between wasm workers under load", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.schedulerHandoffStress))
    .toBe("function");
  await page.evaluate(() => globalThis.schedulerHandoffStress());
});
