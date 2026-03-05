/**
 * @fileoverview E2E tests for app shell: header, nav, and navigation between pages.
 * @module e2e/app.spec
 */

import { test, expect } from "@playwright/test";

test.describe("App shell", () => {
  test("home page shows header and nav", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Maia").first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Chat/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Agents/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Settings/i })).toBeVisible();
  });

  test("navigates to Settings and back", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Settings/i }).click();
    await expect(page).toHaveURL(/view=settings/);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.getByRole("link", { name: /Chat/i }).click();
    await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?(\?.*)?$/);
  });

  test("navigates to Agents and back", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Agents/i }).click();
    await expect(page).toHaveURL(/view=agents/);
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await page.getByRole("link", { name: /Chat/i }).click();
    await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?(\?.*)?$/);
  });
});
