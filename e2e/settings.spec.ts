/**
 * @fileoverview E2E tests for Settings: load, change field, save, verify feedback.
 * We wait for the form to be visible (data loaded) rather than networkidle, because
 * the dev server keeps HMR/connections open so the network never goes idle.
 * @module e2e/settings.spec
 */

import { test, expect } from "@playwright/test";

/** Wait for Settings page to finish loading: heading, form fields, and Save button visible. */
async function waitForSettingsFormReady(page: import("@playwright/test").Page) {
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("Ollama Base URL")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /Save Settings/i })).toBeVisible({ timeout: 10_000 });
}

test.describe("Settings", () => {
  test("loads settings page and shows form", async ({ page }) => {
    await page.goto("/settings");
    await waitForSettingsFormReady(page);
  });

  test("can change Ollama URL and save", async ({ page }) => {
    await page.goto("/settings");
    await waitForSettingsFormReady(page);
    const ollamaInput = page.getByLabel("Ollama Base URL");
    await ollamaInput.clear();
    await ollamaInput.fill("http://localhost:11435");
    await page.getByRole("button", { name: /Save Settings/i }).click();
    await expect(page.getByText(/Saved ✓/)).toBeVisible({ timeout: 5000 });
  });
});
