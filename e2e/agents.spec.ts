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
    const emptyMessage = page.getByText(/No agents yet\. Maia will create agents/i);
    const agentRow = page.locator("main").locator("div.space-y-3 >> div").first();
    await expect(emptyMessage.or(agentRow).first()).toBeVisible({ timeout: 10_000 });
  });
});
