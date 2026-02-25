/**
 * @fileoverview Resolves the Brave browser executable path for Playwright.
 * @module lib/tools/browser-path
 */

import { existsSync } from "fs";

const WINDOWS_DEFAULT =
  process.platform === "win32"
    ? "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
    : null;
const MACOS_DEFAULT =
  process.platform === "darwin"
    ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    : null;
const LINUX_DEFAULTS =
  process.platform === "linux"
    ? [
        "/usr/bin/brave-browser",
        "/usr/bin/brave",
        "/usr/bin/brave-browser-stable",
      ]
    : [];

/**
 * Resolves the Brave executable path from env or OS-specific defaults.
 * @brief Returns Brave path for Playwright chromium.launch({ executablePath }).
 * @returns Brave path or null if not set/found (caller may fall back to Chromium).
 * @note Set BRAVE_EXECUTABLE_PATH to override. On Linux, first existing path in LINUX_DEFAULTS is used.
 */
export function getBraveExecutablePath(): string | null {
  const envPath = process.env.BRAVE_EXECUTABLE_PATH;
  if (envPath && envPath.trim().length > 0) {
    return envPath.trim();
  }
  if (WINDOWS_DEFAULT) return WINDOWS_DEFAULT;
  if (MACOS_DEFAULT) return MACOS_DEFAULT;
  for (const p of LINUX_DEFAULTS) {
    if (existsSync(p)) return p;
  }
  return null;
}
