import { defineConfig } from "@playwright/test";

const site = ["site-live.spec.js"];
const serviceWorker = ["service-worker.spec.js"];

export default defineConfig({
  testDir: "./tests",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "./test-results",
  timeout: 180_000,
  workers: 1,
  webServer: [
    {
      command: "node server.js",
      wait: {
        stdout: /Listening on (?<playwright_test_base_url>http:\/\/127\.0\.0\.1:\d+)/,
      },
      reuseExistingServer: false,
    },
    {
      // The deployed site; site-live.spec.js reads its URL from SITE_BASE_URL.
      command: "node server.js --site",
      wait: {
        stdout: /Listening on (?<site_base_url>http:\/\/127\.0\.0\.1:\d+)/,
      },
      reuseExistingServer: false,
    },
  ],
  projects: [
    ...["chromium", "firefox", "webkit"].map((browserName) => ({
      name: browserName,
      use: { browserName },
      testIgnore: [...site, ...serviceWorker],
    })),
    { name: "service-worker", use: { browserName: "chromium" }, testMatch: serviceWorker },
    { name: "site-live", use: { browserName: "chromium" }, testMatch: site },
  ],
});
