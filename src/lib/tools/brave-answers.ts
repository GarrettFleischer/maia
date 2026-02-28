/**
 * @fileoverview Brave Answers API tool: AI-generated answers backed by real-time web search.
 * Uses the OpenAI-compatible chat/completions endpoint and its own API key (separate billing from Brave Search).
 * @module lib/tools/brave-answers
 */
import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { filterText } from "../security/injection-filter";
import { getBraveAnswersApiKey, BRAVE_ANSWERS_URL } from "./brave-api";
import type { Tool, ToolContext } from "./types";

const schema = z.object({
  q: z.string().describe("Question for web-grounded answer"),
  research: z.boolean().optional().describe("Enable research mode (slower, deeper)"),
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
 * @throws Error if Brave Answers API key is unset or request fails.
 * @note Uses Brave Answers API key (separate billing from Search). Response content is filtered for injection.
 */
async function getBraveAnswer(
  question: string,
  ctx: ToolContext,
  enableResearch: boolean
): Promise<BraveAnswerResult> {
  const key = getBraveAnswersApiKey(ctx);
  if (!key) {
    throw new Error(
      "Brave Answers requires Brave Answers API key. Set it in Settings or BRAVE_ANSWERS_API_KEY in your environment. Get a key at https://api.search.brave.com/.",
    );
  }

  const body = {
    stream: false,
    model: "brave",
    messages: [{ role: "user" as const, content: question }],
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
  const filterSource = enableResearch ? "web_answer:research" : "web_answer";
  const filtered = filterText(rawContent, filterSource);

  return {
    answer: filtered.text,
    fetchedAt: new Date().toISOString(),
  };
}

export const braveAnswersTool: Tool<z.infer<typeof schema>, BraveAnswerResult> = {
  name: "web_answer",
  description:
    "Get an AI-generated answer backed by real-time web search (Brave Answers). Prefer this tool for web-grounded Q&A; use web_search when you need raw links or plan to fetch a specific page. Same API key as web_search. Optionally enable research mode for deeper answers. Example: web_answer({ q: 'What is the current Node.js LTS version?' }).",
  schema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(schema) };
  },
  async execute({ q: question, research: enableResearch }, ctx) {
    return getBraveAnswer(question, ctx, enableResearch ?? false);
  },
};
