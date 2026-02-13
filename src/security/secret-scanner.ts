/**
 * @fileoverview Secret scanner that detects API keys, tokens, and credentials in text.
 * Redacts detected secrets and logs SECRET_DETECTED to the audit log.
 * @module security/secret-scanner
 */

import type { AuditLog } from "../core/types.js";

/**
 * @brief Options for creating a secret scanner.
 */
export interface SecretScannerOptions {
  /** Additional regex patterns (strings) to detect. */
  patterns: string[];
  /** Audit log for security events. */
  auditLog: AuditLog;
}

/**
 * @brief Result of a secret scan.
 */
export interface ScanResult {
  /** Whether any secrets were detected. */
  hasSecrets: boolean;
  /** Descriptions of detected patterns. */
  detections: string[];
  /** Text with secrets replaced by [REDACTED]. */
  redacted: string;
}

/**
 * @brief Factory functions for built-in secret detection patterns.
 * @note Returns fresh RegExp instances to avoid stateful lastIndex issues with /g flag.
 */
const BUILTIN_PATTERNS: Array<{ pattern: () => RegExp; name: string }> = [
  { pattern: () => /sk-proj-\w+/g, name: "OpenAI project key" },
  { pattern: () => /sk-[a-zA-Z0-9_-]{20,}/g, name: "OpenAI API key" },
  { pattern: () => /ghp_[a-zA-Z0-9]{20,}/g, name: "GitHub personal access token" },
  { pattern: () => /xoxb-[a-zA-Z0-9-]+/g, name: "Slack bot token" },
  { pattern: () => /Bearer [a-zA-Z0-9._\-/+=]+/gi, name: "Bearer token" },
  { pattern: () => /-----BEGIN.*KEY-----[\s\S]*?-----END.*KEY-----/g, name: "PEM private key" },
];

/**
 * @brief Creates a secret scanner with built-in and custom patterns.
 * @param options - patterns array and auditLog
 * @returns Secret scanner with scan(text) method
 */
export function createSecretScanner(options: SecretScannerOptions): {
  scan(text: string): ScanResult;
} {
  const { patterns: customPatterns, auditLog } = options;

  const customRegexes = customPatterns.map((p) => {
    try {
      return new RegExp(p, "g");
    } catch {
      return null;
    }
  }).filter((r): r is RegExp => r !== null);

  /**
   * @brief Scans text for secrets and returns redacted version.
   * @param text - Text to scan
   * @returns { hasSecrets, detections, redacted }
   */
  function scan(text: string): ScanResult {
    if (typeof text !== "string") return { hasSecrets: false, detections: [], redacted: "" };

    let redacted = text;
    const detections: string[] = [];

    const seen = new Set<string>();
    for (const { pattern: mkPattern, name } of BUILTIN_PATTERNS) {
      const re = mkPattern();
      const matches = text.match(re);
      if (matches && !seen.has(name)) {
        seen.add(name);
        detections.push(name);
      }
      const re2 = mkPattern();
      redacted = redacted.replace(re2, "[REDACTED]");
    }

    for (const customSrc of customRegexes) {
      const re = new RegExp(customSrc.source, customSrc.flags);
      const matches = text.match(re);
      if (matches && !seen.has("custom pattern")) {
        seen.add("custom pattern");
        detections.push("custom pattern");
      }
      const re2 = new RegExp(customSrc.source, customSrc.flags);
      redacted = redacted.replace(re2, "[REDACTED]");
    }

    const hasSecrets = detections.length > 0;
    if (hasSecrets) {
      auditLog.log("SECRET_DETECTED", { detections }).catch(() => {});
    }

    return { hasSecrets, detections, redacted };
  }

  return { scan };
}
