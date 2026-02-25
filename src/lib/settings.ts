import { credentialCreate, credentialList } from "./security/credential-vault";
import type { AppContext } from "./context";
import type { Settings, SettingsPublic } from "./types";

/** Vault key used for Brave Search API key (encrypted). */
export const BRAVE_SEARCH_CREDENTIAL_KEY = "BRAVE_SEARCH_API_KEY";

/** Vault key used for Brave Answers API key (encrypted; separate product/billing). */
export const BRAVE_ANSWERS_CREDENTIAL_KEY = "BRAVE_ANSWERS_API_KEY";

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
    compressionModel: map.compressionModel ?? "ollama/llama3.2",
    heartbeatIntervalMinutes: parseInt(map.heartbeatIntervalMinutes ?? "30"),
    ollamaBaseUrl: map.ollamaBaseUrl ?? "http://localhost:11434",
    ollamaApiKey: map.ollamaApiKey || undefined,
    openRouterApiKey: map.openRouterApiKey || undefined,
    vllmBaseUrl: map.vllmBaseUrl ?? "http://localhost:8000/v1",
    dockerBaseUrl: map.dockerBaseUrl ?? "http://localhost:8000/v1",
    embeddingModel: map.embeddingModel ?? "nomic-embed-text",
    recentFullCount: Math.max(1, parseInt(map.recentFullCount ?? "10", 10) || 10),
    compressionBatchSize: Math.max(1, parseInt(map.compressionBatchSize ?? "5", 10) || 5),
  };
}

export function getSettingsPublic(ctx: AppContext): SettingsPublic {
  const s = getSettings(ctx);
  const creds = credentialList(ctx);
  const hasBraveKey = creds.includes(BRAVE_SEARCH_CREDENTIAL_KEY);
  const hasBraveAnswersKey = creds.includes(BRAVE_ANSWERS_CREDENTIAL_KEY);
  return {
    whitelistedModels: s.whitelistedModels,
    compressionModel: s.compressionModel,
    heartbeatIntervalMinutes: s.heartbeatIntervalMinutes,
    ollamaBaseUrl: s.ollamaBaseUrl,
    hasOllamaKey: !!s.ollamaApiKey,
    hasOpenRouterKey: !!s.openRouterApiKey,
    hasBraveKey,
    hasBraveAnswersKey,
    vllmBaseUrl: s.vllmBaseUrl,
    dockerBaseUrl: s.dockerBaseUrl,
    embeddingModel: s.embeddingModel,
    recentFullCount: s.recentFullCount,
    compressionBatchSize: s.compressionBatchSize,
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
  if (partial.compressionModel !== undefined) {
    update.run("compressionModel", partial.compressionModel);
  }
  if (partial.heartbeatIntervalMinutes !== undefined) {
    update.run("heartbeatIntervalMinutes", String(partial.heartbeatIntervalMinutes));
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
  if (partial.recentFullCount !== undefined) {
    update.run("recentFullCount", String(partial.recentFullCount));
  }
  if (partial.compressionBatchSize !== undefined) {
    update.run("compressionBatchSize", String(partial.compressionBatchSize));
  }
  if (partial.braveSearchApiKey !== undefined) {
    credentialCreate(ctx, BRAVE_SEARCH_CREDENTIAL_KEY, partial.braveSearchApiKey);
  }
  if (partial.braveAnswersApiKey !== undefined) {
    credentialCreate(ctx, BRAVE_ANSWERS_CREDENTIAL_KEY, partial.braveAnswersApiKey);
  }
}
