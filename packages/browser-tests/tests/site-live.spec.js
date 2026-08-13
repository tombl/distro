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

test("boots and formats a blank persistent disk into the canonical system", async ({ page }) => {
  test.setTimeout(300_000);
  const rootfsRequests = [];
  page.on("pageerror", (error) => console.log(`browser error: ${error.stack ?? error}`));
  page.on("request", (request) => {
    if (/\/rootfs-[^/]+\.erofs$/.test(new URL(request.url()).pathname)) {
      rootfsRequests.push(request.headers());
    }
  });
  await page.route("https://assets.low.land/apk/**", async (route) => {
    const requested = new URL(route.request().url());
    const local = new URL(requested.pathname + requested.search, page.url());
    const response = await page.request.get(local.href);
    await route.fulfill({ response });
  });

  await page.goto("/?webgl=0");
  const { input, terminal } = await waitForGuest(page);
  await expect(terminal).toContainText("Run install-lowland to install this machine locally.");
  await input.pressSequentially(
    "printf 'overlay-%s\\n' write-ok > /live-write-test; cat /live-write-test",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("overlay-write-ok");

  await input.pressSequentially("mount | grep ' on / type overlay'");
  await input.press("Enter");
  await expect(terminal).toContainText("on / type overlay");

  await input.pressSequentially(
    "magic=$(dd if=/dev/vdb bs=1 skip=1080 count=2 2>/dev/null | od -An -tx1 | tr -d ' \\n'); test -b /dev/vdb && test \"$magic\" != 53ef && printf 'install-disk-%s\\n' blank",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("install-disk-blank");

  await input.pressSequentially("install-lowland");
  await input.press("Enter");
  await expect(terminal).toContainText("Installation complete.", { timeout: 120_000 });

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

test("falls back to live-only mode when persistent storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(StorageManager.prototype, "getDirectory", {
      configurable: true,
      value: async () => {
        throw new DOMException("Security error when calling GetDirectory", "SecurityError");
      },
    });
  });

  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.goto("/?webgl=0");

  const terminal = page.locator(".xterm-rows");
  await expect(terminal).toContainText("root@lowland", { timeout: 30_000 });
  await expect(terminal).not.toContainText("install-lowland");

  const input = page.locator(".xterm-helper-textarea");
  await input.pressSequentially(
    "! grep -qw 'lowland.install=1' /proc/cmdline && ! grep -q ' /boot virtiofs ' /proc/mounts && printf 'live-only-%s\\n' ready",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("live-only-ready");
  expect(dialogs).toEqual([]);
});
