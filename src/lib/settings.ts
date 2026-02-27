import { credentialCreate, credentialList } from "./security/credential-vault";
import type { AppContext } from "./context";
import type { ReasoningEffort, Settings, SettingsPublic } from "./types";
import { BUILTIN_HEARTBEAT_JOB_ID, minutesToCronExpression } from "./cron/expression";

/** Vault key used for Brave Search API key (encrypted). */
export const BRAVE_SEARCH_CREDENTIAL_KEY = "BRAVE_SEARCH_API_KEY";

/** Vault key used for Brave Answers API key (encrypted; separate product/billing). */
export const BRAVE_ANSWERS_CREDENTIAL_KEY = "BRAVE_ANSWERS_API_KEY";

const CONTEXT_EFFORT_VALUES: ReasoningEffort[] = ["off", "low", "medium", "high"];
function normalizeContextReasoningEffort(value: unknown): ReasoningEffort {
  if (typeof value === "string" && CONTEXT_EFFORT_VALUES.includes(value as ReasoningEffort)) {
    return value as ReasoningEffort;
  }
  return "medium";
}

export function getSettings(ctx: AppContext): Settings {
  const rows = ctx.db.prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];

  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }

  return {
    whitelistedModels: JSON.parse(map.whitelistedModels ?? "[]"),
    heartbeatIntervalMinutes: parseInt(map.heartbeatIntervalMinutes ?? "30"),
    ollamaBaseUrl: map.ollamaBaseUrl ?? "http://localhost:11434",
    ollamaApiKey: map.ollamaApiKey || undefined,
    openRouterApiKey: map.openRouterApiKey || undefined,
    vllmBaseUrl: map.vllmBaseUrl ?? "http://localhost:8000/v1",
    dockerBaseUrl: map.dockerBaseUrl ?? "http://localhost:8000/v1",
    embeddingModel: map.embeddingModel ?? "nomic-embed-text",
    embedMaxContentLength: Math.max(500, Math.min(32000, parseInt(map.embedMaxContentLength ?? "4000", 10) || 4000)),
    contextQueryModel: map.contextQueryModel ?? "",
    contextSummaryModel: map.contextSummaryModel ?? "",
    contextRecentTurns: Math.max(1, parseInt(map.contextRecentTurns ?? "3", 10) || 3),
    contextReasoningEffort: normalizeContextReasoningEffort(map.contextReasoningEffort),
  };
}

export function getSettingsPublic(ctx: AppContext): SettingsPublic {
  const s = getSettings(ctx);
  const creds = credentialList(ctx);
  const hasBraveKey = creds.includes(BRAVE_SEARCH_CREDENTIAL_KEY);
  const hasBraveAnswersKey = creds.includes(BRAVE_ANSWERS_CREDENTIAL_KEY);
  return {
    whitelistedModels: s.whitelistedModels,
    heartbeatIntervalMinutes: s.heartbeatIntervalMinutes,
    ollamaBaseUrl: s.ollamaBaseUrl,
    hasOllamaKey: !!s.ollamaApiKey,
    hasOpenRouterKey: !!s.openRouterApiKey,
    hasBraveKey,
    hasBraveAnswersKey,
    vllmBaseUrl: s.vllmBaseUrl,
    dockerBaseUrl: s.dockerBaseUrl,
    embeddingModel: s.embeddingModel,
    embedMaxContentLength: s.embedMaxContentLength,
    contextQueryModel: s.contextQueryModel,
    contextSummaryModel: s.contextSummaryModel,
    contextRecentTurns: s.contextRecentTurns,
    contextReasoningEffort: s.contextReasoningEffort,
  };
}

export function updateSettings(
  ctx: AppContext,
  partial: Partial<
    SettingsPublic & {
      openRouterApiKey?: string;
      ollamaApiKey?: string;
      braveSearchApiKey?: string;
      braveAnswersApiKey?: string;
    }
  >
): void {
  const update = ctx.db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
  );

  if (partial.whitelistedModels !== undefined) {
    update.run("whitelistedModels", JSON.stringify(partial.whitelistedModels));
  }
  if (partial.heartbeatIntervalMinutes !== undefined) {
    const minutes = Math.max(1, Math.min(60, Math.floor(partial.heartbeatIntervalMinutes)));
    update.run("heartbeatIntervalMinutes", String(minutes));
    ctx.db.prepare("UPDATE cron_jobs SET expression = ? WHERE id = ?").run(
      minutesToCronExpression(minutes),
      BUILTIN_HEARTBEAT_JOB_ID
    );
  }
  if (partial.ollamaBaseUrl !== undefined) {
    update.run("ollamaBaseUrl", partial.ollamaBaseUrl);
  }
  if (partial.ollamaApiKey !== undefined) {
    update.run("ollamaApiKey", partial.ollamaApiKey);
  }
  if (partial.openRouterApiKey !== undefined) {
    update.run("openRouterApiKey", partial.openRouterApiKey);
  }
  if (partial.vllmBaseUrl !== undefined) {
    update.run("vllmBaseUrl", partial.vllmBaseUrl);
  }
  if (partial.dockerBaseUrl !== undefined) {
    update.run("dockerBaseUrl", partial.dockerBaseUrl);
  }
  if (partial.embeddingModel !== undefined) {
    update.run("embeddingModel", partial.embeddingModel);
  }
  if (partial.embedMaxContentLength !== undefined) {
    const val = Math.max(500, Math.min(32000, Math.floor(partial.embedMaxContentLength)));
    update.run("embedMaxContentLength", String(val));
  }
  if (partial.contextQueryModel !== undefined) {
    update.run("contextQueryModel", partial.contextQueryModel);
  }
  if (partial.contextSummaryModel !== undefined) {
    update.run("contextSummaryModel", partial.contextSummaryModel);
  }
  if (partial.contextRecentTurns !== undefined) {
    update.run("contextRecentTurns", String(Math.max(1, Math.floor(partial.contextRecentTurns))));
  }
  if (partial.contextReasoningEffort !== undefined) {
    const value = CONTEXT_EFFORT_VALUES.includes(partial.contextReasoningEffort)
      ? partial.contextReasoningEffort
      : "medium";
    update.run("contextReasoningEffort", value);
  }
  if (partial.braveSearchApiKey !== undefined) {
    credentialCreate(ctx, BRAVE_SEARCH_CREDENTIAL_KEY, partial.braveSearchApiKey);
  }
  if (partial.braveAnswersApiKey !== undefined) {
    credentialCreate(ctx, BRAVE_ANSWERS_CREDENTIAL_KEY, partial.braveAnswersApiKey);
  }
}
