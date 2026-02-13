/**
 * @fileoverview Structured logger with sensitive data redaction.
 * @module core/logger
 *
 * @note All log output passes through redaction filters that strip API keys,
 * tokens, passwords, and other sensitive patterns before writing.
 */

import type { Logger, LogLevel } from "./types.js";

/**
 * @brief Sensitive key patterns that trigger redaction.
 */
const SENSITIVE_KEYS = new Set([
  "token",
  "password",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "credential",
  "passphrase",
]);

/**
 * @brief Regex patterns for sensitive values in log output.
 */
const SENSITIVE_VALUE_PATTERNS = [
  /sk-proj-[a-zA-Z0-9_-]+/g,
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /xoxb-[a-zA-Z0-9-]+/g,
  /Bearer\s+[a-zA-Z0-9._\-/+=]+/gi,
  /Basic\s+[a-zA-Z0-9+/=]+/gi,
];

/**
 * @brief Log level priority for filtering.
 */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * @brief Options for creating a logger instance.
 */
export interface LoggerOptions {
  /** @brief Minimum log level to output */
  level: LogLevel;
  /** @brief Write function (defaults to console) */
  write: (line: string) => void;
}

/**
 * @brief Redacts sensitive values from a metadata object.
 * @param meta - Metadata to redact
 * @returns Redacted copy of the metadata
 */
function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      let redacted = value;
      for (const pattern of SENSITIVE_VALUE_PATTERNS) {
        redacted = redacted.replace(pattern, "[REDACTED]");
      }
      result[key] = redacted;
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactMeta(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * @brief Creates a structured logger with redaction.
 * @param options - Logger configuration
 * @returns Logger instance
 *
 * @example
 * const logger = createLogger({ level: "info", write: console.log });
 * logger.info("request", { method: "GET", path: "/api" });
 * logger.info("auth", { token: "sk-secret" }); // token is redacted
 */
export function createLogger(options: LoggerOptions): Logger {
  const minPriority = LEVEL_PRIORITY[options.level];

  function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < minPriority) return;

    const timestamp = new Date().toISOString();
    const redactedMeta = meta ? redactMeta(meta) : undefined;
    const metaStr = redactedMeta ? ` ${JSON.stringify(redactedMeta)}` : "";

    options.write(`[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`);
  }

  return {
    debug: (message: string, meta?: Record<string, unknown>) => log("debug", message, meta),
    info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
    error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
  };
}
