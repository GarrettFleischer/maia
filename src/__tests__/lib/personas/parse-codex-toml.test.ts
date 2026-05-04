import { describe, it, expect } from "bun:test";
import { parseCodexPersonaToml } from "@/lib/personas/parse-codex-toml";

describe("parseCodexPersonaToml", () => {
  it("parses a minimal valid Codex-style TOML", () => {
    const raw = `
name = "reviewer"
description = "Does reviews."
model = "gpt-5.3-codex-spark"

[instructions]
text = """Line one.
Line two."""
`;
    const r = parseCodexPersonaToml(raw, "/x/reviewer.toml");
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.id).toBe("reviewer");
    expect(r.name).toBe("reviewer");
    expect(r.description).toBe("Does reviews.");
    expect(r.instructions).toContain("Line one.");
    expect(r.suggestedModelHint).toBe("gpt-5.3-codex-spark");
    expect(r.sourcePath).toBe("/x/reviewer.toml");
  });

  it("returns error when instructions text missing", () => {
    const r = parseCodexPersonaToml(
      'name = "n"\ndescription = "d"\n',
      "/a.toml",
    );
    expect("error" in r).toBe(true);
  });
});
