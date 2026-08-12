import { expect, test } from "@playwright/test";

// Each guest origin names a TCP port in its first label; nothing pre-declares
// them. A distinct port per test keeps the per-context service workers apart.
const origin = (hub, port) => {
  const url = new URL(hub);
  url.hostname = `${port}.bridge.localhost`;
  return url.origin;
};

const hubFor = (page) => page.evaluate(() => globalThis.bridgeOrigin);

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
  const hub = await hubFor(page);

  // A port nothing ever mentioned: the fallback installs the worker, demands a
  // VM through the hub, the VM binds it lazily, and the page reloads to content.
  const guest = await context.newPage();
  trace(guest);
  await bodyReaches(guest, `${origin(hub, 18080)}/some/path?q=1`, "::chunk::");

  const body = await guest.locator("body").innerText();
  expect(body).toContain("/some/path?q=1");
  expect(body).toContain("GET");
  expect(body).toContain('"port":18080'); // the demanded origin's port reached the handler
});

test("echoes a posted request body", async ({ context, page }) => {
  trace(page);
  await page.goto("/");
  const hub = await hubFor(page);

  const guest = await context.newPage();
  trace(guest);
  await bodyReaches(guest, `${origin(hub, 28080)}/warmup`, "::chunk::");

  const echoed = await guest.evaluate(
    async (base) => {
      const response = await fetch(`${base}/submit`, { method: "POST", body: "hello=world" });
      return response.text();
    },
    origin(hub, 28080),
  );
  expect(echoed).toContain("POST");
  expect(echoed).toContain("/submit");
  expect(echoed).toContain("hello=world");
});

test("rejects a non-port origin without a VM", async ({ context, page }) => {
  // A non-numeric label names no guest port: the fallback renders the terminal
  // BAD_PORT page and never registers a worker. No VM page needed.
  const guest = await context.newPage();
  trace(guest);
  await page.goto("/");
  const invalid = new URL(await hubFor(page));
  invalid.hostname = "x.bridge.localhost";
  invalid.pathname = "/some/path";
  await guest.goto(invalid.href);
  await expect(guest.locator("#bridge-code")).toHaveText("BRIDGE_BAD_PORT");
});

test("returns to the connecting page when the VM vanishes", async ({ context, page }) => {
  test.setTimeout(120_000);
  trace(page);
  await page.goto("/");
  const hub = await hubFor(page);

  const guest = await context.newPage();
  trace(guest);
  await bodyReaches(guest, `${origin(hub, 38080)}/warmup`, "::chunk::");

  // Kill the VM page's end of the port: the worker's next relay times out (15s),
  // drops the presumed-dead port, and returns to the connecting page.
  await page.evaluate(() => globalThis.closeBridge());
  const response = await guest.goto(`${origin(hub, 38080)}/some/path`);
  expect(response?.status()).toBe(503);
  await expect(guest.locator("#bridge-code")).toHaveText("BRIDGE_CONNECTING");
});

test("returns guest handler errors as plain text", async ({ context, page }) => {
  trace(page);
  await page.goto("/");
  const hub = await hubFor(page);

  const guest = await context.newPage();
  trace(guest);
  await bodyReaches(guest, `${origin(hub, 48080)}/warmup`, "::chunk::");

  // The stub throws for /boom: the worker returns the handler's message as a
  // plain-text 502 instead of maintaining a second error-page application.
  const response = await guest.goto(`${origin(hub, 48080)}/boom`);
  expect(response?.status()).toBe(502);
  await expect(guest.locator("body")).toContainText("nothing listening on guest port 48080");
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
