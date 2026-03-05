/**
 * @fileoverview E2E tests for Agents page: load, verify empty or list.
 * @module e2e/agents.spec
 */

import { test, expect } from "@playwright/test";

test.describe("Agents", () => {
  test("loads agents page and shows heading", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  });

  test("shows either empty message or agent list", async ({ page }) => {
    await page.goto("/agents");
    // Wait for dashboard to load (loading state clears and content appears)
    await expect(page.getByText("Loading...").first()).toBeHidden({
      timeout: 15_000,
    });
    const statusSection = page.locator('section[aria-label="Agent status"]');
    await expect(statusSection).toBeVisible({ timeout: 5_000 });
    const emptyMessage = statusSection.getByText(/No agents yet\. Maia will create agents/i);
    const firstAgentCard = statusSection.locator("div.grid > div").first();
    await expect(emptyMessage.or(firstAgentCard)).toBeVisible({ timeout: 5_000 });
  });
});
