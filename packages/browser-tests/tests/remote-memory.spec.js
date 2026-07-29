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

test("reclaims process workers after remote-memory churn", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  const memorySample = async (stage) => {
    const bytes = await page.evaluate(async () => {
      const measure = performance.measureUserAgentSpecificMemory;
      if (typeof measure !== "function") return null;
      try {
        return (await measure.call(performance)).bytes;
      } catch {
        return null;
      }
    });
    console.log(JSON.stringify({ test: "remote-memory-lifecycle", stage, memoryBytes: bytes }));
  };
  const workerCount = () => page.workers().length;
  const settledWorkerCount = async () => {
    let previous;
    let stable = 0;
    await expect
      .poll(
        () => {
          const current = workerCount();
          stable = current === previous ? stable + 1 : 0;
          previous = current;
          return stable;
        },
        { intervals: [100, 200, 400, 800, 1_000] },
      )
      .toBeGreaterThanOrEqual(2);
    return workerCount();
  };
  let workersCreated = 0;
  let workersClosed = 0;
  let peakWorkers = 0;
  // The runtime asks the page-side machine controller to create every process
  // worker, so these are top-level dedicated workers rather than workers nested
  // beyond Playwright's page.workers() visibility.
  page.on("worker", (worker) => {
    workersCreated++;
    peakWorkers = Math.max(peakWorkers, workerCount());
    worker.on("close", () => workersClosed++);
  });

  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.startRemoteMemoryLifecycle))
    .toBe("function");
  const pageBaseline = workerCount();
  await memorySample("before");

  try {
    await page.evaluate(() => globalThis.startRemoteMemoryLifecycle());
    // The first guest command lazily creates persistent guest-agent lane
    // workers. Warm those up before measuring process-worker reclamation.
    const warmup = await page.evaluate(() => globalThis.runRemoteMemoryLifecycleBatch("warmup", 1));
    expect(warmup.status).toEqual({ code: 0, signal: null, success: true });
    const machineBaseline = await settledWorkerCount();
    expect(machineBaseline).toBeGreaterThan(pageBaseline);

    for (let batch = 0; batch < 3; batch++) {
      const result = await page.evaluate(
        ({ batch }) => globalThis.runRemoteMemoryLifecycleBatch(batch, 8),
        { batch },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toEqual({ code: 0, signal: null, success: true });
      expect(result.stdout).toBe(`batch=${batch} processes=8\n`);
      await expect.poll(workerCount).toBe(machineBaseline);
      await memorySample(`batch-${batch}`);
    }
    expect(peakWorkers).toBeGreaterThan(machineBaseline);
  } finally {
    await page.evaluate(() => globalThis.closeRemoteMemoryLifecycle());
  }

  await expect.poll(workerCount).toBe(pageBaseline);
  await expect.poll(() => workersClosed).toBe(workersCreated);
  await memorySample("after-close");
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
