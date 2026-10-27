import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/policy",
  testMatch: "**/*.e2e.ts",
  retries: 0,
  forbidOnly: !!process.env.CI,
  workers: 1,
  timeout: 30_000,
  use: { serviceWorkers: "block" },
});
