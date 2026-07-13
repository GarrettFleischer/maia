/**
 * @fileoverview Tests for persistCronJobRow / insertUserCronJob.
 * @module __tests__/lib/cron/create-cron-job.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext } from "../../helpers/fakes";
import { initMaiaAgent } from "@/lib/init";
import {
  insertUserCronJob,
  persistCronJobRow,
  CronJobValidationError,
} from "@/lib/cron/create-cron-job";
import { DEFAULT_CRON_WAKE_PROMPT } from "@/lib/cron/default-wake-prompt";
import { getSettings } from "@/lib/settings";

describe("create-cron-job", () => {
  let ctx: ReturnType<typeof makeTestContext>;

  beforeEach(() => {
    ctx = makeTestContext();
    initMaiaAgent(ctx);
  });

  it("insertUserCronJob wake_up + maia stores default cron message", () => {
    const id = insertUserCronJob(ctx, {
      expression: "0 8 * * *",
      taskDescription: "Morning standup",
      wakeType: "wake_up",
      delegateTo: "maia",
    });
    const row = ctx.db
      .prepare("SELECT * FROM cron_jobs WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row.agent_id).toBe("maia");
    expect(row.persona_id).toBeNull();
    expect(String(row.cron_message)).toContain("Wake up");
  });

  it("insertUserCronJob persona wake_up requires persona and whitelisted model", () => {
    const model = getSettings(ctx).whitelistedModels[0];
    if (!model) {
      throw new Error("test needs at least one whitelisted model");
    }
    const id = insertUserCronJob(ctx, {
      expression: "*/30 * * * *",
      taskDescription: "Persona sweep",
      wakeType: "wake_up",
      delegateTo: "persona",
      personaId: "typescript-pro",
      personaModel: model,
    });
    const row = ctx.db
      .prepare("SELECT * FROM cron_jobs WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row.persona_id).toBe("typescript-pro");
    expect(row.persona_model).toBe(model);
    expect(String(row.cron_message).length).toBeGreaterThan(20);
  });

  it("insertUserCronJob custom without message throws", () => {
    expect(() =>
      insertUserCronJob(ctx, {
        expression: "0 * * * *",
        taskDescription: "x",
        wakeType: "custom",
        delegateTo: "maia",
      }),
    ).toThrow(CronJobValidationError);
  });

  it("persistCronJobRow rejects invalid cron", () => {
    expect(() =>
      persistCronJobRow(ctx, {
        expression: "not a cron",
        taskDescription: "bad",
        agentId: "maia",
        toolName: "cron_echo",
        toolArgs: {},
        personaId: null,
        personaModel: null,
        cronMessage: DEFAULT_CRON_WAKE_PROMPT,
      }),
    ).toThrow(CronJobValidationError);
  });

  it("persistCronJobRow rejects non-maia agent id", () => {
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        "INSERT OR IGNORE INTO agents (id, name, model, system_prompt_extra, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("other", "Other", "ollama/llama3.2", null, "active", now, now);
    expect(() =>
      persistCronJobRow(ctx, {
        expression: "0 * * * *",
        taskDescription: "x",
        agentId: "other",
        toolName: "cron_echo",
        toolArgs: {},
        personaId: null,
        personaModel: null,
        cronMessage: "wake",
      }),
    ).toThrow(/maia/i);
  });
});
