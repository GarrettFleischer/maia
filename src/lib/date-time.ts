/**
 * @fileoverview Utilities for retrieving and formatting the current host system date and time.
 * @module lib/date-time
 */

export interface SystemDateTime {
  /** ISO 8601 representation in UTC, e.g. 2026-02-24T15:04:05.000Z */
  iso: string;
  /** Human-readable local date and time string with timezone, derived from the host locale. */
  local: string;
  /** IANA timezone identifier when available (e.g. America/Los_Angeles), otherwise a short name or UTC. */
  timezone: string;
}

/**
 * @brief Get the current host system date and time in multiple formats.
 * @param now Optional Date instance for testing; defaults to new Date() when omitted.
 * @returns Current system date/time in ISO, local string, and timezone identifier formats.
 * @example
 * const dt = getCurrentSystemDateTime();
 * // dt.iso -> \"2026-02-24T15:04:05.000Z\"
 * // dt.local -> \"2/24/2026, 07:04:05 PST\"
 * // dt.timezone -> \"America/Los_Angeles\"
 */
export function getCurrentSystemDateTime(now: Date = new Date()): SystemDateTime {
  const iso = now.toISOString();

  // Use a fixed locale for predictability while still respecting the host's timezone.
  const local = now.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });

  let timezone = "UTC";
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved && typeof resolved === "string") {
      timezone = resolved;
    }
  } catch {
    // Fallback to UTC when Intl time zone resolution is unavailable.
  }

  return { iso, local, timezone };
}

