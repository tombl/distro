import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "./test-results",
  timeout: 60_000,
  workers: 1,
  use: {
    // Same-site with the *.bridge.localhost:4180 bridge origins: browsers
    // partition a cross-site iframe's service-worker registration, so the
    // main page must share the bridge's site, in tests as in production.
    baseURL: "http://main.bridge.localhost:4181",
  },
  webServer: {
    command: "node server.js",
    port: 4181,
    reuseExistingServer: !process.env.CI,
  },
  // WebKit doesn't resolve *.localhost subdomains, so the bridge origin is
  // unreachable there; chromium and firefox both do.
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          // Playwright disables third-party storage partitioning by default,
          // which hid a real-Chrome breakage: force it on so the suite matches
          // reality. The flag replaces playwright's --disable-features list,
          // which is stability cosmetics we can live without on localhost.
          args: ["--disable-features=Translate", "--enable-features=ThirdPartyStoragePartitioning"],
        },
      },
    },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
});
