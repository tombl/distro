import { expect, test } from "@playwright/test";

// Each guest origin names a TCP port in its first label; nothing pre-declares
// them. A distinct port per test keeps the per-context service workers apart.
const origin = (port) => `http://${port}.bridge.localhost:4180`;

function trace(page) {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
}

// Poll a self-reloading guest page until its body reaches the served content.
async function bodyReaches(page, url, needle) {
  await page.goto(url);
  await expect
    .poll(
      () =>
        page
          .locator("body")
          .innerText()
          .catch(() => ""),
      { timeout: 60_000 },
    )
    .toContain(needle);
}

test("binds an origin nothing pre-declared on a cold navigation", async ({ context, page }) => {
  trace(page);
  await page.goto("/");

  // A port nothing ever mentioned: the fallback installs the worker, demands a
  // VM through the hub, the VM binds it lazily, and the page reloads to content.
  const guest = await context.newPage();
  trace(guest);
  await bodyReaches(guest, `${origin(18080)}/some/path?q=1`, "::chunk::");

  const body = await guest.locator("body").innerText();
  expect(body).toContain("/some/path?q=1");
  expect(body).toContain("GET");
  expect(body).toContain('"port":18080'); // the demanded origin's port reached the handler
});

test("echoes a posted request body", async ({ context, page }) => {
  trace(page);
  await page.goto("/");

  const guest = await context.newPage();
  trace(guest);
  await bodyReaches(guest, `${origin(28080)}/warmup`, "::chunk::");

  const echoed = await guest.evaluate(async (base) => {
    const response = await fetch(`${base}/submit`, { method: "POST", body: "hello=world" });
    return response.text();
  }, origin(28080));
  expect(echoed).toContain("POST");
  expect(echoed).toContain("/submit");
  expect(echoed).toContain("hello=world");
});

test("rejects a non-port origin without a VM", async ({ context }) => {
  // A non-numeric label names no guest port: the fallback renders the terminal
  // BAD_PORT page and never registers a worker. No VM page needed.
  const guest = await context.newPage();
  trace(guest);
  await guest.goto("http://x.bridge.localhost:4180/some/path");
  await expect(guest.locator("#bridge-error-code")).toHaveText("BRIDGE_BAD_PORT");
});

test("diagnoses a vanished VM page", async ({ context, page }) => {
  test.setTimeout(120_000);
  trace(page);
  await page.goto("/");

  const guest = await context.newPage();
  trace(guest);
  await bodyReaches(guest, `${origin(38080)}/warmup`, "::chunk::");

  // Kill the VM page's end of the port: the worker's next relay times out (15s),
  // it drops the presumed-dead port, and serves the mid-connection failure with a
  // live "Open the VM page" link (vmUrl travelled with the port), new-tab so this
  // waiting guest tab could hear a fresh provider.
  await page.evaluate(() => globalThis.closeBridge());
  await guest.goto(`${origin(38080)}/some/path`);
  await expect(guest.locator("#bridge-error-code")).toHaveText("BRIDGE_RELAY_TIMEOUT");
  const link = guest.getByText("Open the VM page");
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("target", "_blank");
});

test("diagnoses a guest handler error", async ({ context, page }) => {
  trace(page);
  await page.goto("/");

  const guest = await context.newPage();
  trace(guest);
  await bodyReaches(guest, `${origin(48080)}/warmup`, "::chunk::");

  // The stub throws for /boom: the worker relays the handler's message verbatim
  // as GUEST_ERROR (502), and derives the 0.0.0.0:<port> fix from the host.
  const response = await guest.goto(`${origin(48080)}/boom`);
  expect(response?.status()).toBe(502);
  await expect(guest.locator("#bridge-error-code")).toHaveText("GUEST_ERROR");
  await expect(guest.locator("body")).toContainText("nothing listening on guest port 48080");
  await expect(guest.locator("body")).toContainText("0.0.0.0:48080");
});

test("close() tears down the provider iframe", async ({ page }) => {
  trace(page);
  await page.goto("/");
  // serveGuest embeds one hidden provider iframe once it wins the Web Lock.
  await expect.poll(() => page.evaluate(() => globalThis.iframeCount())).toBe(1);
  await page.evaluate(() => globalThis.closeBridge());
  expect(await page.evaluate(() => globalThis.iframeCount())).toBe(0);
});

// Skipped: a second VM tab is excluded by the provider Web Lock, so it never
// answers demands. That's hard to drive quickly here (the lock is held for the
// tab's lifetime and the wait is silent), so it isn't covered.
