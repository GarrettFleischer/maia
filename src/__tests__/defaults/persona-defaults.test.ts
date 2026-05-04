/**
 * @fileoverview Ensures shipped default persona templates retain intellectual-honesty guidance.
 * @module __tests__/defaults/persona-defaults
 */

import { describe, it, expect } from "bun:test";
import path from "path";
import { readFileSync } from "fs";

/** @brief Required section heading present in both default persona templates. */
const INTELLECTUAL_HONESTY_HEADING = "## Intellectual honesty";

function readDefaultPersona(...segments: string[]): string {
  const file = path.join(process.cwd(), "defaults", ...segments, "PERSONA.md");
  return readFileSync(file, "utf8");
}

describe("defaults persona templates", () => {
  it("maia PERSONA.md includes intellectual honesty / anti-glaze guidance", () => {
    const md = readDefaultPersona("maia");
    expect(md).toContain(INTELLECTUAL_HONESTY_HEADING);
    expect(md.toLowerCase()).toContain("glaze");
    expect(md.toLowerCase()).toContain("merits");
  });

  it("agent PERSONA.md includes intellectual honesty / anti-glaze guidance", () => {
    const md = readDefaultPersona("agent");
    expect(md).toContain(INTELLECTUAL_HONESTY_HEADING);
    expect(md.toLowerCase()).toContain("glaze");
    expect(md.toLowerCase()).toContain("merits");
  });
});
