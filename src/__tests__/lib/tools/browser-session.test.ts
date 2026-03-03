/**
 * @fileoverview Tests for browser session store (Playwright-backed pages).
 * Verifies that sessions are cached per key and closeSession tears down browsers.
 * @module __tests__/lib/tools/browser-session
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { getOrCreatePage, closeSession } from "@/lib/tools/browser-session";
import * as browserPath from "@/lib/tools/browser-path";
import { chromium } from "playwright";

describe("browser-session", () => {
  const launchSpy = spyOn(chromium, "launch");

  beforeEach(() => {
    launchSpy.mockReset();
  });

  afterEach(async () => {
    launchSpy.mockReset();
  });

  it("reuses the same browser and page for the same session key", async () => {
    const fakeBrowser1 = {
      newPage: async () => ({}),
      close: async () => {},
    } as unknown as Awaited<ReturnType<typeof chromium.launch>>;
    const fakeBrowser2 = {
      newPage: async () => ({}),
      close: async () => {},
    } as unknown as Awaited<ReturnType<typeof chromium.launch>>;
    launchSpy
      .mockResolvedValueOnce(fakeBrowser1)
      .mockResolvedValueOnce(fakeBrowser2);

    const page1 = await getOrCreatePage("session-1");
    const page2 = await getOrCreatePage("session-1");

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(page2.browser).toBe(page1.browser);
    expect(page2.page).toBe(page1.page);
  });

  it("uses Brave executable path when available", async () => {
    const pathSpy = spyOn(
      browserPath,
      "getBraveExecutablePath",
    ).mockReturnValue("/custom/brave");
    const fakeBrowser = {
      newPage: async () => ({}),
      close: async () => {},
    } as unknown as Awaited<ReturnType<typeof chromium.launch>>;
    launchSpy.mockResolvedValue(fakeBrowser);

    await getOrCreatePage("session-2");

    expect(pathSpy).toHaveBeenCalled();
    expect(launchSpy).toHaveBeenCalledWith({
      executablePath: "/custom/brave",
      headless: true,
      args: ["--no-sandbox"],
    });
  });

  it("closes and removes session on closeSession", async () => {
    const fakeBrowser = {
      newPage: async () => ({}),
      close: async () => {},
    } as unknown as Awaited<ReturnType<typeof chromium.launch>>;
    launchSpy.mockResolvedValue(fakeBrowser);

    const entry = await getOrCreatePage("session-3");
    const closeSpy = spyOn(entry.browser, "close").mockResolvedValue();

    await closeSession("session-3");
    expect(closeSpy).toHaveBeenCalled();

    const again = await getOrCreatePage("session-3");
    // New browser should be launched after close
    expect(launchSpy).toHaveBeenCalledTimes(2);
    expect(again.page).toBeDefined();
  });
});
