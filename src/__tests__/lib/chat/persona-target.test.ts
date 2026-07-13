/**
 * @fileoverview Unit tests for catalog persona resolution on user chat messages.
 * @module __tests__/lib/chat/persona-target.test
 */
import { describe, it, expect } from "bun:test";
import { resolveCatalogPersonaForUserMessage } from "@/lib/chat/persona-target";
import type { PersonaDefinition } from "@/lib/types";

const alpha: PersonaDefinition = {
  id: "alpha-persona",
  name: "Alpha",
  description: "d",
  instructions: "inst",
  sourcePath: "/x",
};

function getPersona(id: string): PersonaDefinition | null {
  if (id === "alpha-persona") return alpha;
  return null;
}

describe("resolveCatalogPersonaForUserMessage", () => {
  const maiaThread = { type: "user" as const, participants: ["user", "maia"] };

  it("prefers leading @mention over session default", () => {
    const r = resolveCatalogPersonaForUserMessage(getPersona, {
      message: "@alpha-persona do thing",
      clientTargetAgent: "maia",
      sessionMeta: maiaThread,
      sessionDefaultPersonaId: "alpha-persona",
    });
    expect(r.chosen?.id).toBe("alpha-persona");
    expect(r.usedLeadingMention).toBe(true);
    expect(r.mentionRest).toContain("do thing");
  });

  it("uses client target when it matches a catalog id", () => {
    const r = resolveCatalogPersonaForUserMessage(getPersona, {
      message: "plain",
      clientTargetAgent: "alpha-persona",
      sessionMeta: maiaThread,
      sessionDefaultPersonaId: null,
    });
    expect(r.chosen?.id).toBe("alpha-persona");
    expect(r.usedLeadingMention).toBe(false);
  });

  it("uses session default on user+Maia when no mention and client is maia", () => {
    const r = resolveCatalogPersonaForUserMessage(getPersona, {
      message: "plain",
      clientTargetAgent: "maia",
      sessionMeta: maiaThread,
      sessionDefaultPersonaId: "alpha-persona",
    });
    expect(r.chosen?.id).toBe("alpha-persona");
    expect(r.usedLeadingMention).toBe(false);
  });

  it("ignores session default when thread is not user+Maia", () => {
    const r = resolveCatalogPersonaForUserMessage(getPersona, {
      message: "plain",
      clientTargetAgent: "maia",
      sessionMeta: { type: "user", participants: ["user", "other-agent"] },
      sessionDefaultPersonaId: "alpha-persona",
    });
    expect(r.chosen).toBeNull();
  });
});
