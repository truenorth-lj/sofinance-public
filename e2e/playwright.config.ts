import { defineConfig, devices } from "@playwright/test";

const port = process.env.E2E_PORT ?? "3217";
const externalBase = process.env.BASE_URL;                        // e.g. a running `next dev`, or a deployed URL
const base = externalBase ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  outputDir: "./test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,                 // hermetic only; a live lane must use retries: 0 (a retry could double-spend)
  workers: process.env.CI ? 2 : 3,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",                    // traces hold DOM + network only: the key lives in Node, never in the page
    video: "off",
  },
  projects: [
    { name: "hermetic", testDir: "./tests/hermetic", use: { baseURL: base } },
    { name: "prod-readonly", testDir: "./tests/prod", use: { baseURL: process.env.PROD_URL ?? "https://sofinancelab.xyz", serviceWorkers: "block" }, retries: 0 },
  ],
  webServer: externalBase || process.env.E2E_NO_SERVER ? undefined : {
    command: "node scripts/serve-app.mjs",
    url: `http://localhost:${port}/app`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
