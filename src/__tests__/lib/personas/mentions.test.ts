import { describe, it, expect } from "bun:test";
import { parseLeadingPersonaMention } from "@/lib/personas/mentions";

describe("parseLeadingPersonaMention", () => {
  it("returns null when no leading mention", () => {
    const r = parseLeadingPersonaMention("hello @foo");
    expect(r.personaId).toBeNull();
    expect(r.rest).toBe("hello @foo");
  });

  it("parses @slug and rest", () => {
    const r = parseLeadingPersonaMention("@typescript-pro fix types");
    expect(r.personaId).toBe("typescript-pro");
    expect(r.rest).toBe("fix types");
  });

  it("trims rest when only mention", () => {
    const r = parseLeadingPersonaMention("  @reviewer  ");
    expect(r.personaId).toBe("reviewer");
    expect(r.rest).toBe("");
  });
});
