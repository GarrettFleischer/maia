import { credentialCreate, credentialList } from "./security/credential-vault";
import type { AppContext } from "./context";
import type { ModelGenerationParams, ReasoningEffort, Settings, SettingsPublic } from "./types";
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
    embeddingModel: map.embeddingModel ?? "ollama/nomic-embed-text",
    embedMaxContentLength: Math.max(500, Math.min(32000, parseInt(map.embedMaxContentLength ?? "4000", 10) || 4000)),
    contextQueryModel: map.contextQueryModel ?? "",
    contextSummaryModel: map.contextSummaryModel ?? "",
    contextRecentTurns: Math.max(1, parseInt(map.contextRecentTurns ?? "3", 10) || 3),
    contextReasoningEffort: normalizeContextReasoningEffort(map.contextReasoningEffort),
    archiveDurationValue: Math.max(0, parseInt(map.archiveDurationValue ?? "0", 10) || 0),
    archiveDurationUnit: (["seconds", "minutes", "hours", "days", "months", "years"] as const).includes(
      map.archiveDurationUnit as "seconds"
    )
      ? (map.archiveDurationUnit as "seconds" | "minutes" | "hours" | "days" | "months" | "years")
      : "days",
    modelParams: parseModelParams(map.modelParams),
  };
}

function parseModelParams(raw: string | undefined): Record<string, ModelGenerationParams> {
  if (raw == null || raw === "") return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelGenerationParams>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
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
    embeddingModel: s.embeddingModel,
    embedMaxContentLength: s.embedMaxContentLength,
    contextQueryModel: s.contextQueryModel,
    contextSummaryModel: s.contextSummaryModel,
    contextRecentTurns: s.contextRecentTurns,
    contextReasoningEffort: s.contextReasoningEffort,
    archiveDurationValue: s.archiveDurationValue,
    archiveDurationUnit: s.archiveDurationUnit,
    modelParams: s.modelParams,
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
  const effectiveWhitelist = partial.whitelistedModels ?? getSettings(ctx).whitelistedModels;
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
  if (partial.embeddingModel !== undefined) {
    if (!effectiveWhitelist.includes(partial.embeddingModel)) {
      throw new Error(`Embedding model must be in whitelist: ${partial.embeddingModel}`);
    }
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
  if (partial.archiveDurationValue !== undefined) {
    update.run("archiveDurationValue", String(Math.max(0, Math.floor(partial.archiveDurationValue))));
  }
  if (partial.archiveDurationUnit !== undefined) {
    const unit = ["seconds", "minutes", "hours", "days", "months", "years"].includes(
      partial.archiveDurationUnit
    )
      ? partial.archiveDurationUnit
      : "days";
    update.run("archiveDurationUnit", unit);
  }
  if (partial.braveSearchApiKey !== undefined) {
    credentialCreate(ctx, BRAVE_SEARCH_CREDENTIAL_KEY, partial.braveSearchApiKey);
  }
  if (partial.braveAnswersApiKey !== undefined) {
    credentialCreate(ctx, BRAVE_ANSWERS_CREDENTIAL_KEY, partial.braveAnswersApiKey);
  }
  if (partial.modelParams !== undefined) {
    const filtered: Record<string, ModelGenerationParams> = {};
    for (const [modelId, params] of Object.entries(partial.modelParams)) {
      if (effectiveWhitelist.includes(modelId) && params != null && typeof params === "object") {
        filtered[modelId] = params;
      }
    }
    update.run("modelParams", JSON.stringify(filtered));
  }
}
