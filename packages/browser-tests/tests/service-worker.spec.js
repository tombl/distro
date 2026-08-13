import { expect, test } from "@playwright/test";

test("serves an installed boot tree from OPFS and supports live recovery", async ({ page }) => {
  await page.goto("/");
  test.skip(
    !(await page.evaluate(
      () => "serviceWorker" in navigator && typeof navigator.storage?.getDirectory === "function",
    )),
    "browser does not expose service workers and OPFS",
  );

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("boot", { recursive: true }).catch(() => {});
    const registration = await navigator.serviceWorker.register("/service-worker.js", {
      scope: "/",
    });
    await navigator.serviceWorker.ready;
    if (!registration.active) {
      await new Promise((resolve) =>
        registration.installing?.addEventListener("statechange", resolve, { once: true }),
      );
    }

    const boot = await root.getDirectoryHandle("boot", { create: true });
    const assets = await boot.getDirectoryHandle("assets-v1", { create: true });
    const script = await assets.getFileHandle("boot.js", { create: true });
    const scriptWriter = await script.createWritable();
    await scriptWriter.write('document.body.dataset.booted = "local";');
    await scriptWriter.close();
    const index = await boot.getFileHandle("index.html", { create: true });
    const indexWriter = await index.createWritable();
    await indexWriter.write(
      '<!doctype html><body>local boot<script src="/assets-v1/boot.js"></script>',
    );
    await indexWriter.close();
    const app = await boot.getFileHandle("app.js", { create: true });
    const appWriter = await app.createWritable();
    await appWriter.write("installed sentinel");
    await appWriter.close();
  });

  await page.reload();
  await expect(page.locator("body")).toHaveText("local boot");
  await expect(page.locator("body")).toHaveAttribute("data-booted", "local");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  const live = await page.goto("/?live=1");
  expect(await live.text()).toContain("@lowland/kernel");
  expect(await page.evaluate(() => fetch("/app.js").then((response) => response.text()))).toContain(
    "guestAgent",
  );
});
