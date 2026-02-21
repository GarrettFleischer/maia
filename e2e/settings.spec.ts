/**
 * @fileoverview E2E tests for Settings: load, change field, save, verify feedback.
 * @module e2e/settings.spec
 */

import { test, expect } from "@playwright/test";

test.describe("Settings", () => {
  test("loads settings page and shows form", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Ollama Base URL")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /Save Settings/i })).toBeVisible();
  });

  test("can change Ollama URL and save", async ({ page }) => {
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /Save Settings/i })).toBeVisible({ timeout: 30_000 });
    const ollamaInput = page.getByLabel("Ollama Base URL");
    await ollamaInput.clear();
    await ollamaInput.fill("http://localhost:11435");
    await page.getByRole("button", { name: /Save Settings/i }).click();
    await expect(page.getByText(/Saved ✓/)).toBeVisible({ timeout: 5000 });
  });
});
