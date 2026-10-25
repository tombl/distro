import { expect, test } from "@playwright/test";

test("exec releases the previous image's memory reservation", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => typeof globalThis.execReservations)).toBe("function");
  const depth = 12;
  const result = await page.evaluate((depth) => globalThis.execReservations(depth), depth);
  console.log(JSON.stringify({ test: "exec-reservations", ...result }));

  expect(result.stderr).toBe("");
  expect(result.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.stdout).toContain("ready");
  // The live process holds one reservation however many times it exec'd.
  // Allow one more for a reservation whose worker is still being reclaimed.
  expect(result.before - result.during).toBeLessThanOrEqual(2);
});
