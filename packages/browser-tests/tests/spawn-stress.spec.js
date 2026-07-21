import { expect, test } from "@playwright/test";

test("spawns processes in a burst without exhausting memory", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => typeof globalThis.spawnStress)).toBe("function");
  const result = await page.evaluate(() => globalThis.spawnStress());

  expect(result.stderr).toBe("");
  expect(result.status).toEqual({ code: 0, signal: null, success: true });
});
