import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "./test-results",
  timeout: 180_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: {
    command: "node server.js",
    port: 4173,
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
