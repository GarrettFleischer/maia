import type { AppContext } from "./context";
import type { Settings, SettingsPublic } from "./types";

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
  };
}

export function getSettingsPublic(ctx: AppContext): SettingsPublic {
  const s = getSettings(ctx);
  return {
    whitelistedModels: s.whitelistedModels,
    compressionModel: s.compressionModel,
    heartbeatIntervalMinutes: s.heartbeatIntervalMinutes,
    ollamaBaseUrl: s.ollamaBaseUrl,
    hasOllamaKey: !!s.ollamaApiKey,
    hasOpenRouterKey: !!s.openRouterApiKey,
    vllmBaseUrl: s.vllmBaseUrl,
    dockerBaseUrl: s.dockerBaseUrl,
    embeddingModel: s.embeddingModel,
  };
}

export function updateSettings(
  ctx: AppContext,
  partial: Partial<SettingsPublic & { openRouterApiKey?: string; ollamaApiKey?: string }>
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
}
