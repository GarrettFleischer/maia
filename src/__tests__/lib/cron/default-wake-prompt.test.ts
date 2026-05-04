/**
 * @fileoverview Regression guard for default cron wake copy (task tools + focus).
 * @module __tests__/lib/cron/default-wake-prompt
 */

import { describe, it, expect } from "bun:test";
import { DEFAULT_CRON_WAKE_PROMPT } from "@/lib/cron/default-wake-prompt";

describe("DEFAULT_CRON_WAKE_PROMPT", () => {
  it("mentions task_list and task_update for board maintenance", () => {
    expect(DEFAULT_CRON_WAKE_PROMPT.toLowerCase()).toContain("task_list");
    expect(DEFAULT_CRON_WAKE_PROMPT.toLowerCase()).toContain("task_update");
  });
});
