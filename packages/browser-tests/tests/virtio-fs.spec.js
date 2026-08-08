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
    concurrent: "abcdef",
    entries: ["moved-directory", "renamed"],
    externalMissing: true,
    externalReplacement: "new",
    mode: 0o640,
    mtime: "123.456000000",
    nestedPersisted: "after",
    output: "persistent",
    persisted: "persistent",
    renameDestination: "destination",
    replacement: "new",
  });
});

test("mounts OPFS in a guest and persists a multi-page file", async ({ page }) => {
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  test.skip(
    !(await page.evaluate(() => typeof navigator.storage?.getDirectory === "function")),
    "browser does not expose OPFS",
  );
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.opfsVirtioFileSystemGuest))
    .toBe("function");
  const last = (256 * 1024 - 1) % 251;
  expect(await page.evaluate(() => globalThis.opfsVirtioFileSystemGuest())).toEqual({
    first: 0,
    last,
    persistedFirst: 0,
    persistedLast: last,
    persistedSize: 256 * 1024,
    size: 256 * 1024,
  });
});
