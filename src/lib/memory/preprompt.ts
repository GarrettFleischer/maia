/**
 * @fileoverview Pre-prompt memory recall: registry + PARA snippets within a character budget.
 * @module lib/memory/preprompt
 */

import { createEmbeddingAdapter } from "../knowledge/embedding";
import { getSettings } from "../settings";
import {
  searchRegistryMemories,
  touchRegistryMemories,
} from "./registry";
import { searchMemoryEpisodes, expandGraphNeighbors } from "./graph";
import { collectActiveParaFacts } from "./para";
import { readDailyNote } from "./daily-notes";
import type { AppContext } from "../context";

const DEFAULT_REGISTRY_MAX = 5;
const DEFAULT_MAX_CHARS = 3500;

/**
 * @brief Build markdown block for automatic recall (Gigabrain analogue).
 * @param ctx App context
 * @param agentId Agent id
 * @param userMessage Current user message (for embedding)
 * @param sessionId Current session (optional log)
 * @param maxChars Hard cap on output length
 * @returns Markdown or empty string
 */
export async function buildPrepromptMemoryBlock(
  ctx: AppContext,
  agentId: string,
  userMessage: string,
  _sessionId: string,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<string> {
  const settings = getSettings(ctx);
  if (!userMessage.trim()) return "";
  const embedder = createEmbeddingAdapter(settings, ctx.http);
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedder.embed(userMessage);
  } catch {
    return "";
  }

  const parts: string[] = [];
  let used = 0;

  const regHits = searchRegistryMemories(
    ctx,
    agentId,
    queryEmbedding,
    DEFAULT_REGISTRY_MAX,
  );
  if (regHits.length > 0) {
    touchRegistryMemories(
      ctx,
      regHits.map((h) => h.id),
    );
    const lines = [
      "## Auto-recall (memory registry)",
      ...regHits.map(
        (h, i) => `${i + 1}. (score ${h.score.toFixed(2)}) ${h.content}`,
      ),
    ].join("\n");
    if (used + lines.length + 2 <= maxChars) {
      parts.push(lines);
      used += lines.length + 2;
    }
  }

  const epHits = searchMemoryEpisodes(ctx, agentId, queryEmbedding, 4);
  if (epHits.length > 0 && used < maxChars) {
    const lines = [
      "## Related episodes (cross-session)",
      ...epHits.map((e, i) => {
        const n = expandGraphNeighbors(ctx, agentId, e.id);
        const extra = n.length ? ` [linked: ${n.slice(0, 4).join(", ")}]` : "";
        return `${i + 1}. ${e.summary} [session ${e.sessionId}]${extra}`;
      }),
    ].join("\n");
    if (used + lines.length + 2 <= maxChars) {
      parts.push(lines);
      used += lines.length + 2;
    }
  }

  const paraBundles = collectActiveParaFacts(ctx, agentId, 8);
  if (paraBundles.length > 0 && used < maxChars) {
    const bullets: string[] = ["## PARA (canonical facts — overrides other recall when conflicting)"];
    for (const b of paraBundles) {
      for (const f of b.facts.slice(0, 3)) {
        bullets.push(`- [${b.path}] ${f.fact}`);
        if (bullets.join("\n").length + used > maxChars) break;
      }
    }
    const block = bullets.join("\n");
    if (block.length > 0 && used + block.length <= maxChars) {
      parts.push(block);
      used += block.length;
    }
  }

  const today = new Date().toISOString();
  const daily = readDailyNote(ctx, agentId, today);
  if (daily.trim() && used < maxChars) {
    const snippet = daily.slice(0, Math.min(1200, daily.length));
    const block = `## Today’s daily note (excerpt)\n\n${snippet}`;
    if (used + block.length <= maxChars) parts.push(block);
  }

  return parts.filter(Boolean).join("\n\n---\n\n");
}
