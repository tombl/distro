import { expect, test } from "@playwright/test";

test("adapts OPFS to the virtio filesystem contract", async ({ page }) => {
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  test.skip(
    !(await page.evaluate(() => typeof navigator.storage?.getDirectory === "function")),
    "browser does not expose OPFS",
  );
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.opfsVirtioFileSystem))
    .toBe("function");
  expect(await page.evaluate(() => globalThis.opfsVirtioFileSystem())).toEqual({
    entries: ["moved-directory", "renamed"],
    mode: 0o640,
    nestedPersisted: "after",
    output: "persistent",
    persisted: "persistent",
  });
});
