/**
 * @fileoverview Compresses conversation entries for context: extract data only (no summaries), skip useless messages by storing empty content.
 * @module lib/agent/compression
 */
import type { AppContext } from "../context";
import type { AIProvider } from "../ai/types";
import { appendEntry, updateSessionMeta, getSession } from "../history";
import type { HistoryEntry } from "../types";
import type { Message } from "../ai/types";

const COMPRESSION_PROMPT = `You are a memory compression assistant. Given a conversation entry, extract only important data the LLM needs to recall. Do NOT summarize what was said.

Rules:
- Extract and keep: IDs, names, decisions, errors, key tool results, outcomes. Output only the data: facts and identifiers.
- Do not write prose, full sentences, or "User requested X". No JSON or markdown inside the content. One line or a few bullets max.
- If the message has nothing worth keeping (filler, greetings, redundant, no actionable data), set "skip": true or leave content empty.

Respond ONLY with a JSON object in this exact format:
{
  "content": "<extracted data only, or empty if skip>",
  "role": "<same role as the original>",
  "tags": ["<optional>", "<topic tags>"],
  "skip": false
}

When skip is true (or content is empty), we still store the turn with empty content so history is preserved; the original text is kept elsewhere.`;

/**
 * Compresses a single history entry via the provider; when skip, stores empty content so the original is not lost.
 * @param ctx Application context
 * @param provider AI provider for compression, or null to store as-is
 * @param entry The original entry to compress
 * @param sessionId Session to append the compressed entry to
 * @returns The appended compressed entry (with empty content when skipped)
 */
export async function compressEntry(
  ctx: AppContext,
  provider: AIProvider | null,
  entry: HistoryEntry,
  sessionId: string
): Promise<HistoryEntry> {
  if (!provider) {
    // No compression provider available — store as-is
    return appendEntry(ctx, sessionId, entry, true);
  }

  const messages: Message[] = [
    { role: "system", content: COMPRESSION_PROMPT },
    {
      role: "user",
      content: `Role: ${entry.role}\nContent: ${entry.content}`,
    },
  ];

  const COMPRESSION_TIMEOUT_MS = 15_000;

  let raw = "";
  try {
    const result = await Promise.race([
      provider.complete(messages, [], (token) => { raw += token; }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Compression timeout")), COMPRESSION_TIMEOUT_MS)
      ),
    ]);
    raw = result.content || raw;
  } catch {
    return appendEntry(ctx, sessionId, entry, true);
  }

  // Parse JSON from response; support optional skip (store empty content to preserve history)
  let compressed: { content?: string; role?: string; tags?: string[]; skip?: boolean };
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    compressed = jsonMatch ? JSON.parse(jsonMatch[0]) : { content: entry.content, role: entry.role };
  } catch {
    compressed = { content: entry.content, role: entry.role };
  }

  const shouldSkip =
    compressed.skip === true ||
    (typeof compressed.content === "string" && compressed.content.trim() === "");
  const contentToStore = shouldSkip ? "" : (compressed.content?.trim() || entry.content);

  const compressedEntry: Omit<HistoryEntry, "id"> = {
    role: (compressed.role as HistoryEntry["role"]) || entry.role,
    content: contentToStore,
    toolName: entry.toolName,
    toolArgs: entry.toolArgs,
    timestamp: entry.timestamp,
  };

  // Update session tags if provided
  if (compressed.tags?.length) {
    const existing = getSession(ctx, sessionId);
    if (existing) {
      const merged = Array.from(new Set([...existing.tags, ...compressed.tags]));
      updateSessionMeta(ctx, sessionId, { tags: merged });
    }
  }

  return appendEntry(ctx, sessionId, compressedEntry, true);
}
