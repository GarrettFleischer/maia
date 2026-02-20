import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { searchEntries, searchAcrossSessions, getSession } from "../history";
import type { Tool, ToolContext } from "./types";

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>
): Tool<z.infer<S>> {
  return {
    name, description, schema, execute,
    toDefinition: () => ({ name, description, parameters: zodToJsonSchema(schema) }),
  };
}

export const historyFindTool = makeTool(
  "history_find",
  "Fuzzy search within the current session history.",
  z.object({
    query: z.string().describe("Search query"),
    mode: z.enum(["compressed", "original", "both"]).optional(),
  }),
  async ({ query, mode }, ctx) => searchEntries(query, ctx.sessionId, mode)
);

export const historySearchAllTool = makeTool(
  "history_search_all",
  "Fuzzy search across all sessions in the knowledge base.",
  z.object({
    query: z.string().describe("Search query"),
    tags: z.string().optional().describe("Comma-separated tags to filter by"),
    mode: z.enum(["compressed", "original", "both"]).optional(),
  }),
  async ({ query, tags, mode }) => {
    const tagList = tags?.split(",").map((t) => t.trim()).filter(Boolean);
    return searchAcrossSessions(query, mode, tagList);
  }
);

export const historyGetSessionTool = makeTool(
  "history_get_session",
  "Get the full history of a specific session.",
  z.object({
    sessionId: z.string(),
    mode: z.enum(["compressed", "original", "both"]).optional(),
  }),
  async ({ sessionId, mode }) => {
    const session = getSession(sessionId);
    if (!session) return null;
    if (mode === "compressed") return { ...session, original: [] };
    if (mode === "original") return { ...session, compressed: [] };
    return session;
  }
);

export const historyTools: Tool[] = [
  historyFindTool,
  historySearchAllTool,
  historyGetSessionTool,
];
