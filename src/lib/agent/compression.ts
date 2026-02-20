import { createProvider } from "../ai/factory";
import { getSettings } from "../settings";
import { appendEntry, updateSessionMeta } from "../history";
import type { HistoryEntry } from "../types";
import type { Message } from "../ai/types";

const COMPRESSION_PROMPT = `You are a compression agent. Convert the following exchange into a compressed form.
Rules:
- Remove all greetings, affirmations, pleasantries, filler words
- Remove conversational connectors ("Of course!", "Great!", "Sure, let me...")
- Preserve ALL: facts, decisions, code, file paths, errors, numbers, names
- Code blocks: preserve verbatim (only strip non-essential comments)
- Prose: convert to terse bullet points or key-value facts
- Tool calls: preserve tool name, args, and result summary
- Never invent data. Never infer unstated facts.
- Output: a JSON object with keys "content" (string), "role" (same as input), "tags" (string[])
- tags should be technology names, domains, statuses, or agent names relevant to the exchange`;

export async function compressEntry(
  entry: HistoryEntry,
  sessionId: string
): Promise<HistoryEntry> {
  const settings = getSettings();
  let provider;
  try {
    provider = createProvider(settings.compressionModel);
  } catch {
    // If compression model unavailable, store as-is (compressed = original)
    return appendEntry(sessionId, entry, true);
  }

  const messages: Message[] = [
    { role: "system", content: COMPRESSION_PROMPT },
    {
      role: "user",
      content: `EXCHANGE TO COMPRESS:\n${JSON.stringify(entry, null, 2)}`,
    },
  ];

  let raw = "";
  try {
    const result = await provider.complete(messages, [], (token) => { raw += token; });
    raw = result.content || raw;
  } catch {
    return appendEntry(sessionId, entry, true);
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
    const db = (await import("../db")).getDb();
    const existing = db.prepare("SELECT tags FROM sessions WHERE id = ?").get(sessionId) as { tags: string } | undefined;
    if (existing) {
      const current: string[] = JSON.parse(existing.tags);
      const merged = Array.from(new Set([...current, ...compressed.tags]));
      updateSessionMeta(sessionId, { tags: merged });
    }
  }

  return appendEntry(sessionId, compressedEntry, true);
}
