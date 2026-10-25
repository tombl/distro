import { expect, test } from "@playwright/test";

// The lowland facade only coordinates the packages the other specs cover in
// every engine, so one engine shows that it loads and runs in a browser.
test("boots the lowland Linux facade with an OPFS mount", async ({ browserName, page }) => {
  test.skip(browserName !== "chromium", "the facade is covered in Chromium");
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => typeof globalThis.lowlandLinux)).toBe("function");
  expect(await page.evaluate(() => globalThis.lowlandLinux())).toEqual({
    status: { code: 0, signal: null, success: true },
    stdout: "Linux\n/\nfrom the page\n",
    stderr: "",
    persisted: "from the guest\n",
  });
});
