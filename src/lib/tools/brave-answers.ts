/**
 * @fileoverview Brave Answers API tool: AI-generated answers backed by real-time web search.
 * Uses the OpenAI-compatible chat/completions endpoint; same API key as web_search.
 * @module lib/tools/brave-answers
 */
import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { filterText } from "../security/injection-filter";
import { getBraveSearchApiKey, BRAVE_ANSWERS_URL } from "./brave-api";
import type { Tool, ToolContext } from "./types";

const schema = z.object({
  question: z.string().describe("Question to get a web-grounded AI answer for"),
  enableResearch: z
    .boolean()
    .optional()
    .describe("If true, enable multi-search research mode for thorough answers (slower, higher cost)"),
});

/** Response shape from Brave Answers (OpenAI-compatible). */
interface BraveAnswersResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface BraveAnswerResult {
  answer: string;
  fetchedAt: string;
}

/**
 * @brief Call Brave Answers API (chat/completions) and return the answer text.
 * @param question - User question.
 * @param ctx - Tool context providing HTTP client.
 * @param enableResearch - Whether to enable research mode (multi-search).
 * @returns Object with answer text and fetchedAt timestamp.
 * @throws Error if BRAVE_SEARCH_API_KEY is unset or request fails.
 * @note Uses same X-Subscription-Token as web search; response content is filtered for injection.
 */
async function getBraveAnswer(
  question: string,
  ctx: ToolContext,
  enableResearch: boolean
): Promise<BraveAnswerResult> {
  const key = getBraveSearchApiKey();
  if (!key) {
    throw new Error(
      "Brave Answers requires BRAVE_SEARCH_API_KEY. Set it in your environment (e.g. .env.local). Get a key at https://api.search.brave.com/.",
    );
  }

  const body = {
    stream: false,
    model: "brave",
    messages: [{ role: "user" as const, content: question }],
    ...(enableResearch ? { enable_research: true } : {}),
  };

  const resp = await ctx.http.fetch(BRAVE_ANSWERS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Subscription-Token": key,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(
      `Brave Answers failed: ${resp.status} ${resp.status === 401 ? "(invalid API key)" : ""}`,
    );
  }

  const data = (await resp.json()) as BraveAnswersResponse;
  const rawContent = data?.choices?.[0]?.message?.content ?? "";
  const filtered = filterText(rawContent, "brave_answers");

  return {
    answer: filtered.text,
    fetchedAt: new Date().toISOString(),
  };
}

export const braveAnswersTool: Tool<z.infer<typeof schema>, BraveAnswerResult> = {
  name: "brave_answers",
  description:
    "Get an AI-generated answer backed by real-time web search (Brave Answers). Use for questions that need current, cited information. Same API key as web_search. Optionally enable research mode for deeper answers.",
  schema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(schema) };
  },
  async execute({ question, enableResearch }, ctx) {
    return getBraveAnswer(question, ctx, enableResearch ?? false);
  },
};
