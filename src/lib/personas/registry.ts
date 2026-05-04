/**
 * @fileoverview Loads persona templates from `defaults/personas/catalog` and `data/personas/catalog`,
 * with optional `data/personas/overrides/<id>.md` appended to instructions.
 * @module lib/personas/registry
 */
import fs from "fs";
import path from "path";
import type { PersonaDefinition } from "../types";
import {
  getDataDir,
  getDefaultPersonasCatalogDir,
  getPersonasDataCatalogDir,
  getPersonasOverridesDir,
} from "../data-dir";
import { parseCodexPersonaToml } from "./parse-codex-toml";

/**
 * @brief Lists `.toml` files directly under a directory (non-recursive).
 * @param dir - Absolute directory path
 * @returns Basenames ending in `.toml`
 */
function listTomlFilesInDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".toml"))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * @brief Loads a single persona from a `.toml` path; returns null on failure.
 */
function loadPersonaFromFile(
  filePath: string,
): { persona: PersonaDefinition } | { error: string } {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = parseCodexPersonaToml(raw, filePath);
  if ("error" in parsed) {
    return { error: `${filePath}: ${parsed.error}` };
  }
  return { persona: parsed };
}

/**
 * @brief Appends override markdown from `data/personas/overrides/<id>.md` when present.
 */
function applyOverride(persona: PersonaDefinition): PersonaDefinition {
  const overridePath = path.join(
    getPersonasOverridesDir(),
    `${persona.id}.md`,
  );
  if (!fs.existsSync(overridePath)) return persona;
  const extra = fs.readFileSync(overridePath, "utf-8").trim();
  if (!extra) return persona;
  return {
    ...persona,
    instructions: `${persona.instructions}\n\n## Local override (${persona.id}.md)\n\n${extra}`,
  };
}

/**
 * @brief Merges persona maps: later entries overwrite earlier by `id`.
 */
function mergeById(
  primary: PersonaDefinition[],
  secondary: PersonaDefinition[],
): PersonaDefinition[] {
  const map = new Map<string, PersonaDefinition>();
  for (const p of primary) {
    map.set(p.id, p);
  }
  for (const p of secondary) {
    map.set(p.id, p);
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * @brief Loads all catalog personas from defaults and data directories.
 * @returns Definitions with overrides applied; skips invalid files and logs warnings to console in dev.
 */
export function loadPersonaCatalog(): PersonaDefinition[] {
  const defaultsDir = getDefaultPersonasCatalogDir();
  const dataDir = getPersonasDataCatalogDir();
  const fromDefaults: PersonaDefinition[] = [];
  const fromData: PersonaDefinition[] = [];

  for (const base of [defaultsDir, dataDir]) {
    for (const file of listTomlFilesInDir(base)) {
      const full = path.join(base, file);
      const result = loadPersonaFromFile(full);
      if ("error" in result) {
        console.warn(`[personas] ${result.error}`);
        continue;
      }
      const withOverride = applyOverride(result.persona);
      if (base === defaultsDir) {
        fromDefaults.push(withOverride);
      } else {
        fromData.push(withOverride);
      }
    }
  }

  return mergeById(fromDefaults, fromData);
}

let cachedCatalog: PersonaDefinition[] | null = null;

/**
 * @brief Returns the merged persona catalog (cached for process lifetime).
 */
export function getPersonaCatalog(): PersonaDefinition[] {
  if (!cachedCatalog) {
    cachedCatalog = loadPersonaCatalog();
  }
  return cachedCatalog;
}

/**
 * @brief Clears the in-memory catalog cache (for tests).
 */
export function clearPersonaCatalogCache(): void {
  cachedCatalog = null;
}

/**
 * @brief Looks up a persona by id, or null if missing.
 */
export function getPersonaById(id: string): PersonaDefinition | null {
  return getPersonaCatalog().find((p) => p.id === id) ?? null;
}
