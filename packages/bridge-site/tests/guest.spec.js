import { expect, test } from "@playwright/test";

// busybox httpd inside the guest listens on 8080, so its origin is port 8080.
const GUEST_ORIGIN = "http://8080.bridge.localhost:4180";

function trace(page) {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
}

test("serves a page from busybox httpd inside a real guest", async ({ context, page }) => {
  test.setTimeout(180_000);
  trace(page);
  // vm.html declares no origins; the guest boots lazily on the first demand.
  await page.goto("/vm.html");

  const guest = await context.newPage();
  trace(guest);
  // The cold navigation installs the worker, demands a VM, and boots the guest.
  // The page self-reloads once bound, so poll on the served content.
  await guest.goto(`${GUEST_ORIGIN}/`);
  await expect
    .poll(
      () =>
        guest
          .locator("body")
          .innerText()
          .catch(() => ""),
      { timeout: 120_000 },
    )
    .toContain("hello from the guest");
  await expect(page.locator("#status")).toContainText("serving");
  await expect(guest.locator("h1")).toHaveText("hello from the guest");

  const missing = await guest.evaluate(async () => (await fetch("/missing")).status);
  expect(missing).toBe(404);
});
