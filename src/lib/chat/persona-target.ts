/**
 * @fileoverview Resolves which catalog persona (if any) should handle a plain user chat message.
 * @module lib/chat/persona-target
 */
import type { PersonaDefinition } from "../types";
import { parseLeadingPersonaMention } from "../personas/mentions";
import { isMaiaUserThread } from "../history";

export type SessionMetaLite = {
  type: "user" | "agents";
  participants: string[];
};

/**
 * Precedence: leading @persona mention → client `targetAgent` when it matches a catalog id →
 * session `default_persona_id` on user+Maia threads → none (orchestrator / non-persona agent path).
 */
export function resolveCatalogPersonaForUserMessage(
  getPersonaById: (id: string) => PersonaDefinition | null,
  opts: {
    message: string;
    clientTargetAgent: string;
    sessionMeta: SessionMetaLite | null;
    sessionDefaultPersonaId: string | null;
  },
): {
  chosen: PersonaDefinition | null;
  mentionRest: string;
  usedLeadingMention: boolean;
} {
  const mention = parseLeadingPersonaMention(opts.message);
  let chosen = mention.personaId ? getPersonaById(mention.personaId) : null;
  const usedLeadingMention = Boolean(chosen);

  const clientTarget = opts.clientTargetAgent.trim() || "maia";
  if (!chosen && clientTarget !== "maia") {
    chosen = getPersonaById(clientTarget) ?? null;
  }

  if (
    !chosen &&
    opts.sessionMeta &&
    isMaiaUserThread(opts.sessionMeta.participants, opts.sessionMeta.type)
  ) {
    const def = opts.sessionDefaultPersonaId;
    if (def) chosen = getPersonaById(def) ?? null;
  }

  return { chosen, mentionRest: mention.rest, usedLeadingMention };
}
