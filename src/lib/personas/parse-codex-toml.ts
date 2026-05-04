/**
 * @fileoverview Parses Codex-style persona `.toml` (e.g. from awesome-codex-subagents) into PersonaDefinition fields.
 * @module lib/personas/parse-codex-toml
 */
import { parse as parseToml } from "@iarna/toml";
import type { PersonaDefinition } from "../types";

/** Raw shape after TOML parse (Codex agent file). */
interface CodexTomlRoot {
  name?: string;
  description?: string;
  model?: string;
  model_reasoning_effort?: string;
  sandbox_mode?: string;
  instructions?: { text?: string };
}

/**
 * @brief Parses TOML text into a PersonaDefinition.
 * @param raw - Full `.toml` file contents
 * @param sourcePath - Path stored on the result for debugging
 * @returns PersonaDefinition or error string
 */
export function parseCodexPersonaToml(
  raw: string,
  sourcePath: string,
): PersonaDefinition | { error: string } {
  let doc: unknown;
  try {
    doc = parseToml(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `TOML parse error: ${msg}` };
  }
  if (doc === null || typeof doc !== "object") {
    return { error: "TOML root must be a table" };
  }
  const t = doc as CodexTomlRoot;
  const name = typeof t.name === "string" ? t.name.trim() : "";
  if (!name) {
    return { error: "Missing or empty `name` in persona TOML" };
  }
  const id = name;
  const description =
    typeof t.description === "string" ? t.description.trim() : "";
  const instructions =
    typeof t.instructions?.text === "string" ? t.instructions.text.trim() : "";
  if (!instructions) {
    return { error: `Missing [instructions].text for persona "${id}"` };
  }
  const suggestedModelHint =
    typeof t.model === "string" && t.model.trim() !== ""
      ? t.model.trim()
      : undefined;
  const suggestedReasoningEffort =
    typeof t.model_reasoning_effort === "string" &&
    t.model_reasoning_effort.trim() !== ""
      ? t.model_reasoning_effort.trim()
      : undefined;
  const sandboxMode =
    typeof t.sandbox_mode === "string" && t.sandbox_mode.trim() !== ""
      ? t.sandbox_mode.trim()
      : undefined;

  return {
    id,
    name,
    description,
    instructions,
    suggestedModelHint,
    suggestedReasoningEffort,
    sandboxMode,
    sourcePath,
  };
}
