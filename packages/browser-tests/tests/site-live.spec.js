import { expect, test } from "@playwright/test";

test("the site boots a lazily streamed writable live system", async ({ page }) => {
  test.setTimeout(90_000);
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

  await input.pressSequentially(
    "mkdir -p /mnt; mount /dev/vdb /mnt; echo opfs-persisted > /mnt/probe; sync; umount /mnt; printf 'disk-%s\\n' flushed",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("disk-flushed", { timeout: 15_000 });

  await page.reload();
  const reloadedTerminal = page.locator(".xterm-rows");
  await expect(reloadedTerminal).toContainText("root@lowland", { timeout: 30_000 });
  const reloadedInput = page.locator(".xterm-helper-textarea");
  await reloadedInput.pressSequentially(
    "mkdir -p /mnt; mount /dev/vdb /mnt; cat /mnt/probe; umount /mnt",
  );
  await reloadedInput.press("Enter");
  await expect(reloadedTerminal).toContainText("opfs-persisted");
  expect(rootfsRequests.some((headers) => headers.range?.startsWith("bytes="))).toBe(true);
});
