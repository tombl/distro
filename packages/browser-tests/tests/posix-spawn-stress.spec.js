import { expect, test } from "@playwright/test";

test("hands grown user memory to posix_spawn children", async ({ page }) => {
  test.setTimeout(180_000);
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.posixSpawnHandoffStress))
    .toBe("function");
  await page.evaluate(() => globalThis.posixSpawnHandoffStress());
});
