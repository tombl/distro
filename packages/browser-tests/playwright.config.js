import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "./test-results",
  timeout: 180_000,
  workers: 1,
  webServer: {
    command: "node server.js",
    wait: {
      stdout: /Listening on (?<playwright_test_base_url>http:\/\/127\.0\.0\.1:\d+)/,
    },
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
