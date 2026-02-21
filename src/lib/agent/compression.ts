import type { AppContext } from "../context";
import type { AIProvider } from "../ai/types";
import { appendEntry, updateSessionMeta, getSession } from "../history";
import type { HistoryEntry } from "../types";
import type { Message } from "../ai/types";

const COMPRESSION_PROMPT = `You are a memory compression assistant. Given a conversation entry, produce a compact JSON summary that preserves the key information.

Respond ONLY with a JSON object in this exact format:
{
  "content": "<concise summary of the entry>",
  "role": "<same role as the original>",
  "tags": ["<optional>", "<topic tags>"]
}

Be concise. Preserve tool names and important results. Drop filler and repetition.`;

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

  let raw = "";
  try {
    const result = await provider.complete(messages, [], (token) => { raw += token; });
    raw = result.content || raw;
  } catch {
    return appendEntry(ctx, sessionId, entry, true);
  }

  // Parse JSON from response
  let compressed: { content: string; role: string; tags?: string[] };
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    compressed = jsonMatch ? JSON.parse(jsonMatch[0]) : { content: entry.content, role: entry.role };
  } catch {
    compressed = { content: entry.content, role: entry.role };
  }

  const compressedEntry: Omit<HistoryEntry, "id"> = {
    role: entry.role,
    content: compressed.content || entry.content,
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
