import { getDb } from "./db";
import type { Settings, SettingsPublic } from "./types";

export function getSettings(): Settings {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings").all() as {
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
    openRouterApiKey: map.openRouterApiKey || undefined,
  };
}

export function getSettingsPublic(): SettingsPublic {
  const s = getSettings();
  return {
    whitelistedModels: s.whitelistedModels,
    compressionModel: s.compressionModel,
    heartbeatIntervalMinutes: s.heartbeatIntervalMinutes,
    ollamaBaseUrl: s.ollamaBaseUrl,
    hasOpenRouterKey: !!s.openRouterApiKey,
  };
}

export function updateSettings(partial: Partial<SettingsPublic & { openRouterApiKey?: string }>): void {
  const db = getDb();
  const update = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");

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
  if (partial.openRouterApiKey !== undefined) {
    update.run("openRouterApiKey", partial.openRouterApiKey);
  }
}
