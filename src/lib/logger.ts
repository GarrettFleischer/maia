/**
 * @fileoverview Maia logger: log level from MAIA_LOG_LEVEL env; debug logs only when level is "debug".
 * @module lib/logger
 *
 * Use debug() for timers, heartbeat, tool calls, LLM prompts/responses so they only appear when
 * MAIA_LOG_LEVEL=debug. Use info/warn/error for normal operation logs.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * @brief Parses MAIA_LOG_LEVEL env; defaults to "info".
 * @returns Current log level (unknown values fall back to "info").
 */
export function getLogLevel(): LogLevel {
  const raw = process.env.MAIA_LOG_LEVEL?.toLowerCase().trim();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

/**
 * @brief Whether debug logging is enabled (MAIA_LOG_LEVEL=debug).
 * @returns true if debug messages will be emitted.
 */
export function isDebug(): boolean {
  return getLogLevel() === "debug";
}

function shouldLog(level: LogLevel): boolean {
  const current = LEVEL_ORDER[getLogLevel()];
  const messageLevel = LEVEL_ORDER[level];
  return messageLevel >= current;
}

function formatMessage(tag: string, data?: Record<string, unknown>): string {
  const prefix = `[maia:${tag}]`;
  if (data === undefined || Object.keys(data).length === 0) {
    return prefix;
  }
  try {
    return `${prefix} ${JSON.stringify(data)}`;
  } catch {
    return `${prefix} ${String(data)}`;
  }
}

/**
 * @brief Logs a debug message (only when MAIA_LOG_LEVEL=debug).
 * @param tag - Short category, e.g. "heartbeat", "timer", "llm", "tool".
 * @param data - Optional object to serialize (avoid logging huge payloads; truncate in caller if needed).
 */
export function debug(tag: string, data?: Record<string, unknown>): void {
  if (!shouldLog("debug")) return;
  const msg = formatMessage(tag, data);
  console.debug(msg);
}

/**
 * @brief Logs an info message when level is info or debug.
 */
export function info(tag: string, data?: Record<string, unknown>): void {
  if (!shouldLog("info")) return;
  const msg = formatMessage(tag, data);
  console.info(msg);
}

/**
 * @brief Logs a warning when level is warn, info, or debug.
 */
export function warn(tag: string, data?: Record<string, unknown>): void {
  if (!shouldLog("warn")) return;
  const msg = formatMessage(tag, data);
  console.warn(msg);
}

/**
 * @brief Logs an error (always logged unless you change level to something above error; error is max).
 */
export function error(tag: string, data?: Record<string, unknown>): void {
  if (!shouldLog("error")) return;
  const msg = formatMessage(tag, data);
  console.error(msg);
}

/** @brief Truncates string for debug logs; default max 500 chars. */
export function truncateForLog(s: string, maxLen: number = 500): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `…[truncated ${s.length - maxLen} more]`;
}
