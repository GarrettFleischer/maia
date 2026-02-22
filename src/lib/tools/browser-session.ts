/**
 * @fileoverview Session-scoped browser store for agent-mode browser tools.
 * One Playwright browser + page per sessionKey; lifecycle: create on first use, close on browser_close or optional idle timeout.
 * @module lib/tools/browser-session
 */

import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { getBraveExecutablePath } from "./browser-path";

interface SessionEntry {
  browser: Browser;
  page: Page;
}

const store = new Map<string, SessionEntry>();

/**
 * Gets or creates a browser page for the given session key.
 * Uses Brave if BRAVE_EXECUTABLE_PATH or OS default is available, otherwise Chromium.
 * @param sessionKey - Typically ctx.sessionId (or agentId + sessionId).
 * @returns Existing or newly created { browser, page }.
 * @note Cleanup: call closeSession(sessionKey) when done (e.g. browser_close tool). Idle timeout can be added later.
 */
export async function getOrCreatePage(sessionKey: string): Promise<{
  browser: Browser;
  page: Page;
}> {
  const existing = store.get(sessionKey);
  if (existing) return existing;

  const bravePath = getBraveExecutablePath();
  const browser = await chromium.launch({
    executablePath: bravePath ?? undefined,
    headless: true,
    args: bravePath ? ["--no-sandbox"] : undefined,
  });
  const page = await browser.newPage();
  const entry: SessionEntry = { browser, page };
  store.set(sessionKey, entry);
  return entry;
}

/**
 * Closes the browser for the given session and removes it from the store.
 * @param sessionKey - Same key used with getOrCreatePage.
 */
export async function closeSession(sessionKey: string): Promise<void> {
  const entry = store.get(sessionKey);
  if (!entry) return;
  store.delete(sessionKey);
  await entry.browser.close();
}
