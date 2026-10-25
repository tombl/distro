import { expect, test } from "@playwright/test";

// Browsers cap how many WebAssembly.Memory reservations a tab can hold
// (Chromium about 124, WebKit about 15 at a 4 GiB maximum), and every guest
// process owns one. WebKit only has about 12 left after boot, so this holds
// few enough processes to fit there at one reservation each, but not at two.
const processes = 8;

test("holds one memory reservation per spawned background process", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.processReservations))
    .toBe("function");
  const result = await page.evaluate((count) => globalThis.processReservations(count), processes);
  const perProcess = (result.idle - result.held) / processes;
  console.log(
    JSON.stringify({
      test: "process-reservations",
      processes,
      idle: result.idle,
      held: result.held,
      perProcess,
    }),
  );

  expect(result.stderr).toBe("");
  expect(result.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.stdout).toContain("ready\n");
  expect(perProcess).toBeGreaterThan(0.5);
  expect(perProcess).toBeLessThan(1.5);
});
