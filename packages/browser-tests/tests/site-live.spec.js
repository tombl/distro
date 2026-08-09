import { expect, test } from "@playwright/test";

test("the site boots a lazily streamed writable live system", async ({ page }) => {
  test.setTimeout(240_000);
  const rootfsRequests = [];
  page.on("pageerror", (error) => console.log(`browser error: ${error.stack ?? error}`));
  page.on("request", (request) => {
    if (request.url().endsWith(".squashfs")) rootfsRequests.push(request.headers());
  });

  await page.goto("/?webgl=0");
  const terminal = page.locator(".xterm-rows");
  await expect(terminal).toContainText("root@lowland", { timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("data-guest-ready", "true", {
    timeout: 30_000,
  });

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
  await expect(page.locator("html")).toHaveAttribute("data-guest-ready", "true", {
    timeout: 30_000,
  });
  const reloadedInput = page.locator(".xterm-helper-textarea");
  await reloadedInput.pressSequentially(
    "mkdir -p /mnt; mount /dev/vdb /mnt; cat /mnt/probe; umount /mnt; echo remount-ready",
  );
  await reloadedInput.press("Enter");
  await expect(reloadedTerminal).toContainText("opfs-persisted");
  await expect(reloadedTerminal).toContainText("remount-ready");

  await reloadedInput.pressSequentially("install-lowland");
  await reloadedInput.press("Enter");
  await expect(reloadedTerminal).toContainText("Installation complete.", { timeout: 120_000 });

  const liveRootfsRequests = rootfsRequests.length;
  await page.reload();
  const installedTerminal = page.locator(".xterm-rows");
  await expect(installedTerminal).toContainText("root@lowland", { timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("data-guest-ready", "true", {
    timeout: 30_000,
  });
  const installedInput = page.locator(".xterm-helper-textarea");
  await installedInput.pressSequentially(
    'while read d p t o rest; do [ "$p" = / ] && echo root-$d-$t-$o; done < /proc/mounts',
  );
  await installedInput.press("Enter");
  await expect(installedTerminal).toContainText("root-/dev/root-ext4-rw");
  expect(rootfsRequests).toHaveLength(liveRootfsRequests);
  expect(rootfsRequests.some((headers) => headers.range?.startsWith("bytes="))).toBe(true);
});
