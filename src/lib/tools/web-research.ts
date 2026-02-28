/**
 * @fileoverview Brave Answers research tool: streaming multi-search answers via Brave Answers API.
 * Uses stream mode with enable_research for thorough, research-grade responses.
 * @module lib/tools/web-research
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { filterText } from "../security/injection-filter";
import { getBraveAnswersApiKey, BRAVE_ANSWERS_URL } from "./brave-api";
import type { Tool, ToolContext } from "./types";
import type { BraveAnswerResult } from "./brave-answers";

const schema = z.object({
  question: z
    .string()
    .describe(
      "Single comprehensive research question covering all aspects of the topic. Combine multiple angles into one complete query; do not split into separate calls.",
    ),
  enableCitations: z
    .boolean()
    .optional()
    .describe(
      "Reserved for future use. Currently ignored because Brave Answers research mode does not support enable_citations.",
    ),
  enableEntities: z
    .boolean()
    .optional()
    .describe(
      "Reserved for future use. Currently ignored because Brave Answers research mode does not support enable_entities.",
    ),
  language: z.string().optional().describe("Optional response language (e.g. 'en', 'de')."),
  country: z
    .string()
    .optional()
    .describe("Optional target country for search results (e.g. 'us', 'de')."),
});

/**
 * @brief Call Brave Answers API in streaming research mode and aggregate the answer text.
 * @param question - User research question.
 * @param ctx - Tool context providing HTTP client.
 * @param options - Optional research options (citations, language, country). enableEntities is currently ignored.
 * @returns Object with aggregated answer text and fetchedAt timestamp.
 * @throws Error if Brave Answers API key is unset or request fails.
 * @note Uses Brave Answers API key (separate billing from Search). Response content is filtered for injection.
 */
async function getBraveResearchAnswer(
  question: string,
  ctx: ToolContext,
  options: {
    enableCitations?: boolean;
    enableEntities?: boolean;
    language?: string;
    country?: string;
  },
): Promise<BraveAnswerResult> {
  const key = getBraveAnswersApiKey(ctx);
  if (!key) {
    throw new Error(
      "Brave Answers requires Brave Answers API key. Set it in Settings or BRAVE_ANSWERS_API_KEY in your environment. Get a key at https://api.search.brave.com/.",
    );
  }

  const body: Record<string, unknown> = {
    stream: true,
    model: "brave",
    messages: [{ role: "user" as const, content: question }],
    enable_research: true,
  };

  if (options.enableCitations === true) body.enable_citations = true;
  // Brave Answers research mode does not support enable_entities; accept the option but do not send it.
  if (options.language) body.language = options.language;
  if (options.country) body.country = options.country;

  const resp = await ctx.http.fetch(BRAVE_ANSWERS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Subscription-Token": key,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Brave Answers (research) failed: ${resp.status} ${resp.status === 401 ? "(invalid API key)" : ""} ${text}`,
    );
  }

  const rawStream = await resp.text();
  const lines = rawStream.split("\n");
  let combinedContent = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
      };
    } catch {
      continue;
    }

    const choice = (parsed as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0];
    const deltaContent = choice?.delta?.content;
    if (typeof deltaContent === "string" && deltaContent.length > 0) {
      combinedContent += deltaContent;
    }
  }

  const filtered = filterText(combinedContent, "web_research");

  return {
    answer: filtered.text,
    fetchedAt: new Date().toISOString(),
  };
}

export const webResearchTool: Tool<z.infer<typeof schema>, BraveAnswerResult> = {
  name: "web_research",
  description:
    "Run a deep, streaming research query using Brave Answers (research mode). Call ONCE with a single comprehensive question that covers all aspects of the research (e.g. combine scam investigation, reviews, connections into one query). Do not make multiple calls with smaller queries—the API performs multi-search internally. Same API key as web_answer.",
  schema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(schema) };
  },
  async execute({ question, enableCitations, enableEntities, language, country }, ctx) {
    return getBraveResearchAnswer(question, ctx, {
      enableCitations,
      enableEntities,
      language,
      country,
    });
  },
};

