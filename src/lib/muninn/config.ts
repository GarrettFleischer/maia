/**
 * @fileoverview MuninnDB configuration from app settings.
 * @module lib/muninn/config
 *
 * Reads the Muninn base URL from Settings (AI Providers → MuninnDB URL).
 * When empty, Muninn is disabled.
 */

import type { AppContext } from "../context";
import { getSettings } from "../settings";

export interface MuninnConfig {
  /** Base URL for MuninnDB REST API (e.g. http://localhost:8475). Empty when disabled. */
  baseUrl: string;
  /** True when baseUrl is non-empty and Muninn should be used. */
  enabled: boolean;
}

/**
 * Returns Muninn configuration from app settings.
 * @param ctx - Application context (used to read settings).
 * @returns Config with baseUrl (trimmed, trailing slash removed) and enabled flag.
 */
export function getMuninnConfig(ctx: AppContext): MuninnConfig {
  const url = (getSettings(ctx).muninnUrl ?? "").trim().replace(/\/+$/, "");
  return {
    baseUrl: url,
    enabled: url.length > 0,
  };
}
