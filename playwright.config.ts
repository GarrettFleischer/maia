/**
 * @fileoverview Playwright E2E test configuration. Uses PLAYWRIGHT_BASE_URL when set (e.g. by
 * scripts/start-e2e-server.ts, which finds a free port). Otherwise starts Next.js via webServer.
 * @module playwright.config
 */

import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // When PLAYWRIGHT_BASE_URL is set, the server was already started (e.g. by start-e2e-server.ts).
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "bun run dev",
        url: baseURL,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
      },
});
