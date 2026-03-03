/**
 * @fileoverview Logging facade for the application. Use debug/info/warn/error with
 * optional structured fields so log format and level are consistent.
 * @module lib/logger
 *
 * @note Do not log credential values, API keys, or PII. See docs/architecture/security.md.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Optional structured fields attached to a log entry (e.g. agentId, sessionId). */
export interface LogFields {
  agentId?: string;
  sessionId?: string;
  [key: string]: string | number | boolean | undefined;
}

function formatMessage(level: LogLevel, message: string, fields?: LogFields): string {
  const parts = [new Date().toISOString(), level.toUpperCase(), message];
  if (fields && Object.keys(fields).length > 0) {
    const filtered = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    ) as Record<string, string | number | boolean>;
    if (Object.keys(filtered).length > 0) {
      parts.push(JSON.stringify(filtered));
    }
  }
  return parts.join(" ");
}

/**
 * Log at debug level.
 * @param message - Log message
 * @param fields - Optional structured fields (agentId, sessionId, etc.)
 */
export function debug(message: string, fields?: LogFields): void {
  console.debug(formatMessage("debug", message, fields));
}

/**
 * Log at info level.
 * @param message - Log message
 * @param fields - Optional structured fields
 */
export function info(message: string, fields?: LogFields): void {
  console.info(formatMessage("info", message, fields));
}

/**
 * Log at warn level.
 * @param message - Log message
 * @param fields - Optional structured fields
 */
export function warn(message: string, fields?: LogFields): void {
  console.warn(formatMessage("warn", message, fields));
}

/**
 * Log at error level.
 * @param message - Log message
 * @param fields - Optional structured fields
 */
export function error(message: string, fields?: LogFields): void {
  console.error(formatMessage("error", message, fields));
}
