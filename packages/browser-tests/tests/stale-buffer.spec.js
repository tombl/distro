import { expect, test } from "@playwright/test";

test.setTimeout(30_000);

test("refreshes a worker's view after shared Wasm memory grows", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof globalThis.sharedMemoryGrowProof === "function" &&
          typeof globalThis.schedulerHandoffStress === "function",
      ),
    )
    .toBe(true);

  // Pure-JS proof of the browser primitive: sharedMemoryGrowProof in ../app.js.
  const proof = await page.evaluate(() => globalThis.sharedMemoryGrowProof());
  console.log(`shared memory proof: ${JSON.stringify(proof)}`);
  expect(proof.grower.previousPages).toBe(143);
  expect(proof.observer.actualPages).toBe(151);
  expect(proof.observer.refreshedBytes).toBe(151 * 64 * 1024);

  console.log("starting kernel handoff");
  await page.evaluate(() => globalThis.schedulerHandoffStress());
});
