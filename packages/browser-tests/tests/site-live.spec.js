import { expect, test } from "@playwright/test";

test("the site boots a lazily streamed writable live system", async ({ page }) => {
  test.setTimeout(45_000);
  const rootfsRequests = [];
  page.on("pageerror", (error) => console.log(`browser error: ${error.stack ?? error}`));
  page.on("request", (request) => {
    if (request.url().endsWith(".squashfs")) rootfsRequests.push(request.headers());
  });

  await page.goto("/?webgl=0");
  const terminal = page.locator(".xterm-rows");
  await expect(terminal).toContainText("root@lowland", { timeout: 30_000 });

  const input = page.locator(".xterm-helper-textarea");
  await input.pressSequentially("echo overlay-write-ok > /live-write-test; cat /live-write-test");
  await input.press("Enter");
  await expect(terminal).toContainText("overlay-write-ok");

  await input.pressSequentially("mount | grep ' on / type overlay'");
  await input.press("Enter");
  await expect(terminal).toContainText("on / type overlay");
  expect(rootfsRequests.some((headers) => headers.range?.startsWith("bytes="))).toBe(true);
});
