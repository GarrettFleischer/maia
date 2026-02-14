/**
 * @fileoverview Real clock adapter wrapping the Date object.
 * @module adapters/clock
 *
 * @note Returns the actual current system time. Tests use fixedClock()
 * from the test helpers instead.
 */

import type { Clock } from "../core/types.js";

/**
 * @brief Creates a real clock that returns the current system time.
 * @returns Clock implementation backed by Date
 *
 * @example
 * const clock = createRealClock();
 * console.log(clock.todayString()); // "2026-02-13"
 */
export function createRealClock(): Clock {
  return {
    /**
     * @brief Returns the current date and time.
     * @returns Date object representing now
     */
    now(): Date {
      return new Date();
    },

    /**
     * @brief Returns today's date as YYYY-MM-DD in local time.
     * @returns Date string in YYYY-MM-DD format
     */
    todayString(): string {
      const d = new Date();
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    },

    /**
     * @brief Returns the current time as an ISO 8601 timestamp.
     * @returns ISO 8601 string
     */
    timestamp(): string {
      return new Date().toISOString();
    },
  };
}
