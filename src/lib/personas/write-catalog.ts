/**
 * @fileoverview Builds Codex-style persona `.toml` bodies for Maia-only writes under `data/personas/catalog`.
 * @module lib/personas/write-catalog
 */

/**
 * @brief Escapes content embedded in a TOML multiline basic string (`""" ... """`).
 * @param text - Raw instruction body
 * @returns Escaped text safe inside triple-double quotes
 */
export function escapeTomlMultilineBasicBody(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * @brief Validates a persona catalog basename / template name field (no path segments).
 * @param id - Proposed persona id
 * @throws Error when id is empty or contains unsafe characters
 */
export function assertSafePersonaCatalogId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,126}$/.test(id)) {
    throw new Error(
      "persona id must start with alphanumeric and use only letters, digits, hyphen, underscore",
    );
  }
}

function escapeTomlBasicSingleLine(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * @brief Builds a `.toml` file Maia can write into `data/personas/catalog`.
 * @param params - Persona id (also used as `name` in template), description, instructions
 * @returns UTF-8 TOML text parseable by `parseCodexPersonaToml`
 * @note Instructions must not contain the literal sequence `\"\"\"` (triple double-quote).
 */
export function buildPersonaCatalogToml(params: {
  id: string;
  description: string;
  instructions: string;
}): string {
  assertSafePersonaCatalogId(params.id);
  if (params.description.includes("\n") || params.description.includes("\r")) {
    throw new Error("description must be a single line for persona_catalog_upsert");
  }
  if (params.instructions.includes('"""')) {
    throw new Error('instructions must not contain the sequence """');
  }
  const nameLine = `name = "${escapeTomlBasicSingleLine(params.id)}"`;
  const descLine = `description = "${escapeTomlBasicSingleLine(params.description)}"`;
  const instrBody = escapeTomlMultilineBasicBody(params.instructions);
  return `${nameLine}\n${descLine}\n\n[instructions]\ntext = """${instrBody}"""`;
}
