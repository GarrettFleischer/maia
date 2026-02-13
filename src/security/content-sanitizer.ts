/**
 * @fileoverview Content sanitizer for prompt injection detection, wrapping untrusted
 * content, and stripping control characters. Logs injection events to the audit log.
 * @module security/content-sanitizer
 */

import type { AuditLog } from "../core/types.js";

/**
 * @brief Options for creating a content sanitizer.
 */
export interface ContentSanitizerOptions {
  /** Whether to run injection detection. */
  detection: boolean;
  /** Whether to wrap content with markers. */
  wrapping: boolean;
  /** Audit log for security events. */
  auditLog: AuditLog;
}

/**
 * @brief Result of injection analysis.
 */
export interface AnalyzeResult {
  /** Whether injection patterns were detected. */
  injectionDetected: boolean;
  /** List of matched pattern strings. */
  patterns: string[];
}

/**
 * @brief Content sanitizer instance returned by createContentSanitizer.
 */
export interface ContentSanitizer {
  analyze(text: string): AnalyzeResult;
  wrap(text: string): string;
  sanitize(text: string): string;
}

const INJECTION_PATTERNS = [
  "ignore previous instructions",
  "you are now",
  "system prompt",
  "reveal your",
];

/**
 * @brief Creates a content sanitizer for prompt injection defense.
 * @param options - detection, wrapping, and auditLog
 * @returns Content sanitizer with analyze, wrap, and sanitize methods
 */
export function createContentSanitizer(options: ContentSanitizerOptions): ContentSanitizer {
  const { detection, wrapping, auditLog } = options;

  /**
   * @brief Analyzes text for prompt injection patterns (case-insensitive).
   * @param text - Text to analyze
   * @returns { injectionDetected, patterns }
   */
  function analyze(text: string): AnalyzeResult {
    const patterns: string[] = [];
    const lower = (text ?? "").toLowerCase();

    for (const pattern of INJECTION_PATTERNS) {
      if (lower.includes(pattern.toLowerCase())) {
        patterns.push(pattern);
      }
    }

    const injectionDetected = patterns.length > 0;
    if (injectionDetected) {
      auditLog.log("INJECTION_DETECTED", { patterns }).catch(() => {});
    }

    return { injectionDetected, patterns };
  }

  /**
   * @brief Wraps text with untrusted content markers.
   * @param text - Text to wrap
   * @returns Wrapped text
   */
  function wrap(text: string): string {
    return `<<<EXTERNAL_UNTRUSTED_CONTENT>>>\n${text ?? ""}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>`;
  }

  /**
   * @brief Strips control characters, preserving \\n, \\r, \\t.
   * @param text - Text to sanitize
   * @returns Cleaned text
   */
  function sanitize(text: string): string {
    if (typeof text !== "string") return "";
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  }

  return {
    analyze: (t: string) => (detection ? analyze(t) : { injectionDetected: false, patterns: [] }),
    wrap: (t: string) => (wrapping ? wrap(t) : t ?? ""),
    sanitize,
  };
}
