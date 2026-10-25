import { test as base } from "@playwright/test";

// WebKit disables OPFS in ephemeral browser contexts, which is what
// Playwright gives each test, so OPFS tests get a persistent one there.
export const test = base.extend({
  context: async ({ browserName, context, playwright, baseURL }, use, testInfo) => {
    if (browserName !== "webkit") return use(context);
    const persistent = await playwright.webkit.launchPersistentContext(
      testInfo.outputPath("webkit-profile"),
      { baseURL },
    );
    await use(persistent);
    await persistent.close();
  },
});
export { expect } from "@playwright/test";
