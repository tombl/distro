import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "./test-results",
  timeout: 60_000,
  workers: 1,
  webServer: {
    command: "node server.js",
    // The main URL must be same-site with the dynamically allocated
    // *.bridge.localhost origins. Playwright captures it as baseURL.
    wait: {
      stdout: /Listening on (?<playwright_test_base_url>http:\/\/main\.bridge\.localhost:\d+)/,
    },
    reuseExistingServer: false,
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
