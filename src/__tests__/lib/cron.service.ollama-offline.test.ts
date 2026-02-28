/**
 * @fileoverview Tests for cron scheduler behavior when agent runs fail (e.g. Ollama offline).
 * @module __tests__/lib/cron.service.ollama-offline.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import type { AppContext } from "@/lib/context";
import { startCronScheduler, stopCronScheduler } from "@/lib/cron/service";

describe("cron scheduler when agent run fails", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
    // Reset any prior scheduler state between tests.
    stopCronScheduler();
  });

  it("does not throw when runAgentFn rejects for a non-heartbeat cron job", () => {
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        "INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "cron-test-job",
        "*/5 * * * *",
        "Test job",
        "maia",
        0,
        now,
        "cron_echo",
        "{}",
      );

    const runAgentFn = async (): Promise<string> => {
      throw new Error("simulated Ollama /api/chat failure");
    };

    // Starting the scheduler should not throw even if future agent runs fail; errors are caught and logged.
    expect(() =>
      startCronScheduler(ctx, runAgentFn, { runOnInit: false }),
    ).not.toThrow();
  });
});
