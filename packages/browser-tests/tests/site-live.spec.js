import { expect, test } from "@playwright/test";

// The deployed site, from the config's second web server.
test.use({ baseURL: process.env.SITE_BASE_URL });

// The whole terminal buffer, scrollback included, with rows that xterm wrapped
// joined back up, so output that later boot messages scroll out of view
// still counts.
function terminalText(page) {
  return page.evaluate(() => {
    const buffer = window.terminal.buffer.active;
    let text = "";
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (row > 0 && !line.isWrapped) text += "\n";
      text += line.translateToString(true);
    }
    return text;
  });
}

// Commands print their markers through printf, so a pattern anchored to a
// whole line matches the output and never the echoed command.
function expectOutput(page, pattern, options) {
  return expect.poll(() => terminalText(page), options).toMatch(pattern);
}

async function run(input, command) {
  await input.pressSequentially(command);
  await input.press("Enter");
}

// The motd banner can scroll away before anything looks for it, so readiness
// is a round trip through the shell: retype a marker command until its output
// comes back.
async function waitForShell(page) {
  const input = page.locator(".xterm-helper-textarea");
  const id = Math.random().toString(36).slice(2, 10);
  await expect(async () => {
    await run(input, `printf 'ready-%s\\n' ${id}`);
    await expectOutput(page, new RegExp(`^ready-${id}$`, "m"), { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  return input;
}

async function waitForGuest(page) {
  const input = await waitForShell(page);
  await run(
    input,
    "until grep -q ' /boot virtiofs ' /proc/mounts; do sleep 1; done; printf 'boot-%s\\n' mounted",
  );
  await expectOutput(page, /^boot-mounted$/m, { timeout: 30_000 });
  return input;
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
  await page.goto("/?webgl=0");

  const input = await waitForShell(page);
  expect(await terminalText(page)).not.toContain("install-lowland");

  await run(
    input,
    "! grep -qw 'lowland.install=1' /proc/cmdline && ! grep -q ' /boot virtiofs ' /proc/mounts && printf 'live-only-%s\\n' ready",
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
