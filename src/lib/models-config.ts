/**
 * @fileoverview Whitelisted models source: data/models.json, copied from defaults on first run.
 * Provides whitelisted model ids and per-model generation params for settings and AI.
 * @module lib/models-config
 */

import fs from "fs";
import path from "path";
import { getDataDir } from "./data-dir";
import type { DbAdapter } from "./context";
import type { ModelGenerationParams, ModelsJsonEntry } from "./types";

const MODELS_FILENAME = "models.json";

/** Path to data/models.json (source of truth at runtime). */
export function getModelsJsonPath(): string {
  return path.join(getDataDir(), MODELS_FILENAME);
}

/** Path to defaults/models.json (shipped template). */
function getDefaultModelsJsonPath(): string {
  return path.resolve(process.cwd(), "defaults", MODELS_FILENAME);
}

/**
 * Copies defaults/models.json to data/models.json if data/models.json does not exist.
 * When db is provided and file is missing, migrates from settings.whitelistedModels and
 * settings.modelParams if present; otherwise copies from defaults.
 * @param db - Optional DB adapter for migration from existing settings table
 * @note Does not overwrite existing data/models.json.
 */
export function ensureModelsJson(db?: DbAdapter): void {
  const dataPath = getModelsJsonPath();
  if (fs.existsSync(dataPath)) return;
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });

  if (db) {
    const whitelistedRaw = db.prepare("SELECT value FROM settings WHERE key = ?").get("whitelistedModels") as
      | { value: string }
      | undefined;
    const modelParamsRaw = db.prepare("SELECT value FROM settings WHERE key = ?").get("modelParams") as
      | { value: string }
      | undefined;
    const list = whitelistedRaw?.value ? (JSON.parse(whitelistedRaw.value) as string[]) : null;
    if (Array.isArray(list) && list.length > 0) {
      let params: Record<string, ModelGenerationParams> = {};
      try {
        if (modelParamsRaw?.value) params = JSON.parse(modelParamsRaw.value) as Record<string, ModelGenerationParams>;
      } catch {
        /* ignore */
      }
      const entries: ModelsJsonEntry[] = list.map((id) => {
        const slash = id.indexOf("/");
        const provider = slash >= 0 ? id.slice(0, slash) : "ollama";
        const name = slash >= 0 ? id.slice(slash + 1) : id;
        const entry: ModelsJsonEntry = { provider, name };
        const p = params[id];
        if (p?.temperature !== undefined) entry.temperature = p.temperature;
        if (p?.top_p !== undefined) entry.top_p = p.top_p;
        if (p?.top_k !== undefined) entry.top_k = p.top_k;
        if (p?.min_p !== undefined) entry.min_p = p.min_p;
        if (p?.presence_penalty !== undefined) entry.presence_penalty = p.presence_penalty;
        if (p?.repetition_penalty !== undefined) entry.repetition_penalty = p.repetition_penalty;
        if (p?.options !== undefined && Object.keys(p.options).length > 0) entry.options = p.options;
        return entry;
      });
      fs.writeFileSync(dataPath, JSON.stringify(entries, null, 2), "utf-8");
      // Remove from DB so models live only in the JSON file from now on
      db.prepare("DELETE FROM settings WHERE key = ?").run("whitelistedModels");
      db.prepare("DELETE FROM settings WHERE key = ?").run("modelParams");
      return;
    }
  }

  const defaultsPath = getDefaultModelsJsonPath();
  if (!fs.existsSync(defaultsPath)) {
    fs.writeFileSync(dataPath, "[]", "utf-8");
    return;
  }
  fs.copyFileSync(defaultsPath, dataPath);
}

/**
 * Extracts ModelGenerationParams from a models.json entry (optional fields only).
 * @param entry - Single entry from models.json
 * @returns Params object or undefined if no optional params
 */
function entryToModelParams(entry: ModelsJsonEntry): ModelGenerationParams | undefined {
  const {
    provider,
    name,
    temperature,
    top_p,
    top_k,
    min_p,
    presence_penalty,
    repetition_penalty,
    options,
  } = entry;
  const hasAny =
    temperature !== undefined ||
    top_p !== undefined ||
    top_k !== undefined ||
    min_p !== undefined ||
    presence_penalty !== undefined ||
    repetition_penalty !== undefined ||
    (options !== undefined && Object.keys(options).length > 0);
  if (!hasAny) return undefined;
  const params: ModelGenerationParams = {};
  if (temperature !== undefined) params.temperature = temperature;
  if (top_p !== undefined) params.top_p = top_p;
  if (top_k !== undefined) params.top_k = top_k;
  if (min_p !== undefined) params.min_p = min_p;
  if (presence_penalty !== undefined) params.presence_penalty = presence_penalty;
  if (repetition_penalty !== undefined) params.repetition_penalty = repetition_penalty;
  if (options !== undefined && Object.keys(options).length > 0) params.options = options;
  return params;
}

/**
 * Reads data/models.json (ensures file exists first), returns whitelisted model ids and model params.
 * @param db - Optional DB adapter; when provided and file is missing, migrates from settings table first
 * @returns { whitelistedModels: string[], modelParams: Record<string, ModelGenerationParams> }
 */
export function readModelsConfig(db?: DbAdapter): {
  whitelistedModels: string[];
  modelParams: Record<string, ModelGenerationParams>;
} {
  ensureModelsJson(db);
  const dataPath = getModelsJsonPath();
  const raw = fs.readFileSync(dataPath, "utf-8");
  let entries: ModelsJsonEntry[];
  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    entries = [];
  }
  const whitelistedModels: string[] = [];
  const modelParams: Record<string, ModelGenerationParams> = {};
  for (const entry of entries) {
    if (entry && typeof entry.provider === "string" && typeof entry.name === "string") {
      const id = `${entry.provider}/${entry.name}`;
      whitelistedModels.push(id);
      const params = entryToModelParams(entry);
      if (params) modelParams[id] = params;
    }
  }
  return { whitelistedModels, modelParams };
}

/**
 * Writes data/models.json from an array of entries. Overwrites existing file.
 * @param entries - Array of ModelsJsonEntry (provider, name, optional params)
 */
export function writeModelsConfig(entries: ModelsJsonEntry[]): void {
  ensureModelsJson();
  const dataPath = getModelsJsonPath();
  const normalized = entries.map((e) => {
    const { provider, name, temperature, top_p, top_k, min_p, presence_penalty, repetition_penalty, options } = e;
    const out: ModelsJsonEntry = { provider, name };
    if (temperature !== undefined) out.temperature = temperature;
    if (top_p !== undefined) out.top_p = top_p;
    if (top_k !== undefined) out.top_k = top_k;
    if (min_p !== undefined) out.min_p = min_p;
    if (presence_penalty !== undefined) out.presence_penalty = presence_penalty;
    if (repetition_penalty !== undefined) out.repetition_penalty = repetition_penalty;
    if (options !== undefined && Object.keys(options).length > 0) out.options = options;
    return out;
  });
  fs.writeFileSync(dataPath, JSON.stringify(normalized, null, 2), "utf-8");
}
