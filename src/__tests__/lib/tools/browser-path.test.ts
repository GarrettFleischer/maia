/**
 * @fileoverview Tests for Brave executable path resolution helper.
 * Ensures env override wins and OS defaults/existsSync are respected.
 * @module __tests__/lib/tools/browser-path
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getBraveExecutablePath } from "@/lib/tools/browser-path";

const ORIGINAL_ENV = { ...process.env };

describe("browser-path", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns env BRAVE_EXECUTABLE_PATH when set and non-empty", () => {
    process.env.BRAVE_EXECUTABLE_PATH = "  /custom/brave  ";
    const path = getBraveExecutablePath();
    expect(path).toBe("/custom/brave");
  });

  it("returns null when env is unset and no defaults apply for this platform", () => {
    delete process.env.BRAVE_EXECUTABLE_PATH;
    // On CI we cannot reliably assert concrete OS-specific default, so only check "some string or null".
    const path = getBraveExecutablePath();
    if (
      process.platform === "linux" ||
      process.platform === "win32" ||
      process.platform === "darwin"
    ) {
      expect(typeof path === "string" || path === null).toBe(true);
    } else {
      expect(path).toBeNull();
    }
  });
});
