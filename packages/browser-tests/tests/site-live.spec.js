import { expect, test } from "@playwright/test";

async function waitForGuest(page) {
  const terminal = page.locator(".xterm-rows");
  await expect(terminal).toContainText("root@lowland", { timeout: 30_000 });
  const input = page.locator(".xterm-helper-textarea");
  await input.pressSequentially(
    "until grep -q ' /boot virtiofs ' /proc/mounts; do sleep 1; done; printf 'boot-%s\\n' mounted",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("boot-mounted", { timeout: 30_000 });
  return { input, terminal };
}

test("boots, persists its install disk, and installs the canonical system", async ({ page }) => {
  test.setTimeout(300_000);
  const rootfsRequests = [];
  page.on("pageerror", (error) => console.log(`browser error: ${error.stack ?? error}`));
  page.on("request", (request) => {
    if (/\/rootfs-[^/]+\.erofs$/.test(new URL(request.url()).pathname)) {
      rootfsRequests.push(request.headers());
    }
  });

  await page.goto("/?webgl=0");
  const { input, terminal } = await waitForGuest(page);
  await input.pressSequentially(
    "printf 'overlay-%s\\n' write-ok > /live-write-test; cat /live-write-test",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("overlay-write-ok");

  await input.pressSequentially("mount | grep ' on / type overlay'");
  await input.press("Enter");
  await expect(terminal).toContainText("on / type overlay");

  await input.pressSequentially(
    "mkdir -p /mnt; mount -t ext4 LABEL=LOWLAND_INSTALL /mnt; echo opfs-persisted > /mnt/probe; sync; umount /mnt; printf 'disk-%s\\n' flushed",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("disk-flushed", { timeout: 15_000 });

  await page.reload();
  const { input: reloadedInput, terminal: reloadedTerminal } = await waitForGuest(page);
  await reloadedInput.pressSequentially(
    "mkdir -p /mnt; mount -t ext4 LABEL=LOWLAND_INSTALL /mnt; cat /mnt/probe; umount /mnt; printf 'remount-%s\\n' ready",
  );
  await reloadedInput.press("Enter");
  await expect(reloadedTerminal).toContainText("opfs-persisted");
  await expect(reloadedTerminal).toContainText("remount-ready");

  await reloadedInput.pressSequentially("install-lowland");
  await reloadedInput.press("Enter");
  await expect(reloadedTerminal).toContainText("Installation complete.", { timeout: 120_000 });

  const liveRootfsRequests = rootfsRequests.length;
  await page.reload();
  const { input: installedInput, terminal: installedTerminal } = await waitForGuest(page);
  await installedInput.pressSequentially(
    "mount | grep ' on / type ext4 (rw'; printf 'installed-root-%s\\n' ready",
  );
  await installedInput.press("Enter");
  await expect(installedTerminal).toContainText("on / type ext4 (rw", { timeout: 15_000 });
  await expect(installedTerminal).toContainText("installed-root-ready");

  await installedInput.pressSequentially(
    "printf user-customized > /boot/index.html; apk --allow-untrusted fix --reinstall lowland-boot; grep -qx user-customized /boot/index.html && test -f /boot/index.html.apk-new && printf 'protected-boot-%s\\n' ok",
  );
  await installedInput.press("Enter");
  await expect(installedTerminal).toContainText("protected-boot-ok", { timeout: 60_000 });

  expect(rootfsRequests).toHaveLength(liveRootfsRequests);
  expect(rootfsRequests.some((headers) => headers.range?.startsWith("bytes="))).toBe(true);
});
