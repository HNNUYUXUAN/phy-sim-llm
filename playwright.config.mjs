import { defineConfig } from "./scripts/fixed-playwright.mjs";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.mjs",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: `http://127.0.0.1:${process.env.PHYSIM_TEST_PORT ?? 4185}`,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: `node tests/serve.mjs index.html ${process.env.PHYSIM_TEST_PORT ?? 4185}`,
    url: `http://127.0.0.1:${process.env.PHYSIM_TEST_PORT ?? 4185}`,
    reuseExistingServer: false,
    timeout: 15_000
  },
  projects: [
    { name: "chromium-dpr1", use: { browserName: "chromium", deviceScaleFactor: 1 } },
    { name: "chromium-dpr2", use: { browserName: "chromium", deviceScaleFactor: 2 } },
    { name: "chromium-dpr3", use: { browserName: "chromium", deviceScaleFactor: 3 } }
  ]
});
