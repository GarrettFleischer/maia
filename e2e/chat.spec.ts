/**
 * @fileoverview E2E tests for chat: type message, submit, verify message in UI,
 * and that server-driven (async) agent messages update the UI.
 * Mocks /api/sessions/active so the app starts with empty state (Welcome to Maia visible).
 * @module e2e/chat.spec
 */

import { test, expect } from "@playwright/test";

/** Empty session response so the chat page shows welcome state and no prior messages. */
const emptySession = { sessionId: null, session: null };

test.describe("Chat", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/sessions/active", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, body: JSON.stringify(emptySession) });
      } else {
        await route.continue();
      }
    });
  });

  test("user can type and submit a message and see it in the UI", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Welcome to Maia/i)).toBeVisible();
    const input = page.getByPlaceholder(/Message Maia/i);
    await input.fill("Hello E2E");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Hello E2E")).toBeVisible();
  });

  test("UI updates when server sends an async agent message (no user interaction)", async ({
    page,
    baseURL,
  }) => {
    const E2E_ASYNC_SESSION_ID = "e2e-async-session-1";
    await page.route("**/api/sessions/active", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          body: JSON.stringify({ sessionId: E2E_ASYNC_SESSION_ID, session: { original: [] } }),
        });
      } else {
        await route.continue();
      }
    });
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body =
        "data: " + JSON.stringify({ type: "done", sessionId: E2E_ASYNC_SESSION_ID }) + "\n\n";
      await route.fulfill({
        status: 200,
        body,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    await page.goto("/");
    await expect(page.getByText(/Welcome to Maia/i)).toBeVisible();
    const input = page.getByPlaceholder(/Message Maia/i);
    await input.fill("Trigger session");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Trigger session").first()).toBeVisible({ timeout: 15_000 });

    const asyncContent = "Async reply from agent E2E " + Date.now();
    const emitRes = await page.request.post(`${baseURL}/api/test/emit-event`, {
      data: {
        event: "message",
        data: {
          sessionId: E2E_ASYNC_SESSION_ID,
          entry: {
            id: "e2e-async-" + Date.now(),
            role: "agent",
            content: asyncContent,
            timestamp: new Date().toISOString(),
          },
          participants: [],
        },
      },
    });
    expect(emitRes.ok()).toBe(true);

    await expect(page.getByText(asyncContent)).toBeVisible({ timeout: 10_000 });
  });
});
