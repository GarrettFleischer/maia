/**
 * @fileoverview Tests for Codex-style persona `.toml` serialization used by persona_catalog_upsert.
 * @module __tests__/lib/personas/write-catalog.test
 */
import { describe, it, expect } from "bun:test";
import {
  assertSafePersonaCatalogId,
  buildPersonaCatalogToml,
  escapeTomlMultilineBasicBody,
} from "@/lib/personas/write-catalog";
import { parseCodexPersonaToml } from "@/lib/personas/parse-codex-toml";

describe("write-catalog", () => {
  it("escapeTomlMultilineBasicBody escapes backslashes and quotes", () => {
    const out = escapeTomlMultilineBasicBody(`say "hi" \\`);
    expect(out).toContain(String.raw`\"hi\"`);
    expect(out.endsWith("\\\\")).toBe(true);
  });

  it("assertSafePersonaCatalogId rejects unsafe ids", () => {
    expect(() => assertSafePersonaCatalogId("../evil")).toThrow();
    expect(() => assertSafePersonaCatalogId("")).toThrow();
    expect(() => assertSafePersonaCatalogId("ok-slug_01")).not.toThrow();
  });

  it("buildPersonaCatalogToml round-trips through parseCodexPersonaToml", () => {
    const raw = buildPersonaCatalogToml({
      id: "my-persona",
      description: 'Uses "quotes" and \\ slashes.',
      instructions: "Line one.\nLine two with \"quotes\".",
    });
    const parsed = parseCodexPersonaToml(raw, "/tmp/test.toml");
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.id).toBe("my-persona");
    expect(parsed.name).toBe("my-persona");
    expect(parsed.description).toBe('Uses "quotes" and \\ slashes.');
    expect(parsed.instructions).toBe('Line one.\nLine two with "quotes".');
  });

  it("buildPersonaCatalogToml rejects triple-double-quote sequences in instructions", () => {
    expect(() =>
      buildPersonaCatalogToml({
        id: "x",
        description: "d",
        instructions: 'bad """ sequence',
      }),
    ).toThrow();
  });
});
