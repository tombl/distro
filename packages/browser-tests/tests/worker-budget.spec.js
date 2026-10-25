import { expect, test } from "@playwright/test";

test("fails clones with EAGAIN once the worker budget is exhausted", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => typeof globalThis.workerBudget)).toBe("function");
  const result = await page.evaluate(() => globalThis.workerBudget());

  expect(result.stderr).toContain("vfork: Resource temporarily unavailable");
  expect(result.stderr).not.toContain("Out of memory");
  expect(result.stdout).toBe("recovered\n");
  expect(result.status).toEqual({ code: 0, signal: null, success: true });
});
