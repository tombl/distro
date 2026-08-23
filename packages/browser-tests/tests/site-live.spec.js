import { expect, test } from "@playwright/test";

async function waitForGuestReady(page) {
  await expect(page.locator("[data-terminal]")).toHaveAttribute("aria-busy", "false", {
    timeout: 30_000,
  });
  const terminal = page.locator(".xterm-rows");
  const input = page.locator(".xterm-helper-textarea");
  return { input, terminal };
}

async function waitForGuest(page) {
  const { input, terminal } = await waitForGuestReady(page);
  await input.pressSequentially(
    "until grep -q ' /boot virtiofs ' /proc/mounts; do sleep 1; done; printf 'boot-%s\\n' mounted",
  );
  await expectOutput(page, /^boot-mounted$/m, { timeout: 30_000 });
  return input;
}

test("boots and formats a blank persistent disk into the canonical system", async ({
  browserName,
  page,
}) => {
  test.skip(browserName === "firefox", "persistent installation is not supported in Firefox");
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
  const input = await waitForGuest(page);
  await expectOutput(page, /Run install-lowland to install this machine locally\./);
  await run(input, "printf 'overlay-%s\\n' write-ok > /live-write-test; cat /live-write-test");
  await expectOutput(page, /^overlay-write-ok$/m);

  await run(input, "mount | grep ' on / type overlay'");
  await expectOutput(page, /^\S+ on \/ type overlay /m);

  await run(
    input,
    "magic=$(dd if=/dev/vdb bs=1 skip=1080 count=2 2>/dev/null | od -An -tx1 | tr -d ' \\n'); test -b /dev/vdb && test \"$magic\" != 53ef && printf 'install-disk-%s\\n' blank",
  );
  await expectOutput(page, /^install-disk-blank$/m);

  await run(input, "install-lowland");
  await expectOutput(page, /Installation complete\./, { timeout: 120_000 });

  const liveRootfsRequests = rootfsRequests.length;
  await page.reload();
  const installedInput = await waitForGuest(page);
  await run(
    installedInput,
    "mount | grep ' on / type ext4 (rw'; printf 'installed-root-%s\\n' ready",
  );
  await expectOutput(page, /^\S+ on \/ type ext4 \(rw/m, { timeout: 15_000 });
  await expectOutput(page, /^installed-root-ready$/m);

  await run(
    installedInput,
    "printf user-customized > /boot/index.html; apk --allow-untrusted fix --reinstall lowland-boot; grep -qx user-customized /boot/index.html && test -f /boot/index.html.apk-new && printf 'protected-boot-%s\\n' ok",
  );
  await expectOutput(page, /^protected-boot-ok$/m, { timeout: 60_000 });

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
  await page.goto("/?webgl=0&cmdline=lowland.test%3Da%2Bb");

  const { input, terminal } = await waitForGuestReady(page);
  await expect(terminal).not.toContainText("install-lowland");

  await input.pressSequentially(
    "! grep -qw 'lowland.install=1' /proc/cmdline && grep -qw 'lowland.test=a+b' /proc/cmdline && ! grep -q ' /boot virtiofs ' /proc/mounts && printf 'live-only-%s\\n' ready",
  );
  await expectOutput(page, /^live-only-ready$/m);
  expect(dialogs).toEqual([]);
});

// keep_bootcon keeps the boot console open for the whole session, so console
// output must reach the terminal without waiting for it to close.
for (const cmdline of ["keep_bootcon", '"keep-bootcon=1"']) {
  test(`shows the shell with ${cmdline}`, async ({ page }) => {
    await page.goto(`/?webgl=0&cmdline=${encodeURIComponent(cmdline)}`);
    const terminal = page.locator(".xterm-rows");
    await expect(terminal).toContainText("root@lowland", { timeout: 60_000 });
    const input = page.locator(".xterm-helper-textarea");
    await input.pressSequentially("printf 'console-%s\\n' visible");
    await input.press("Enter");
    await expect(terminal).toContainText("console-visible");
  });
}
