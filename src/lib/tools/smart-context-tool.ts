/**
 * @fileoverview Smart context tool: allows LLMs to query history and knowledge base
 * with context and command parameters. Prefer this over knowledge_search and
 * history_semantic_search for accessing knowledge and history.
 * @module lib/tools/smart-context-tool
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { getSettings } from "../settings";
import type { AppContext } from "../context";
import {
  extractSearchQueriesFromContextAndCommand,
  buildRawRetrievedContext,
  filterRelevantSources,
  buildRawTextFromChunks,
  summarizeRetrievedContext,
} from "../agent/context-query";
import type { Tool, ToolContext } from "./types";

const schema = z.object({
  context: z
    .string()
    .describe(
      "What to base the search queries on (e.g. the user's question, prior discussion topics, relevant background)",
    ),
  command: z
    .string()
    .describe("What you are trying to accomplish with this search (e.g. find past discussions about X)"),
});

export const smartContextTool: Tool<z.infer<typeof schema>> = {
  name: "smart_context",
  description:
    "Query history and knowledge base using context and command. Generates search queries from your context, retrieves relevant history and knowledge entries, filters and summarizes them. Prefer this over knowledge_search and history_semantic_search when you need to access prior knowledge or session history—it produces better, focused results.",
  schema,
  toDefinition: () => ({
    name: "smart_context",
    description:
      "Query history and knowledge base using context and command. Generates search queries from your context, retrieves relevant history and knowledge entries, filters and summarizes them. Prefer this over knowledge_search and history_semantic_search when you need to access prior knowledge or session history—it produces better, focused results.",
    parameters: zodToJsonSchema(schema),
  }),
  execute: async ({ context, command }, ctx) => {
    const settings = getSettings(ctx);
    const providerFactory = ctx.providerFactory;

    const contextProviderFactory = providerFactory
      ? (model: string, c: AppContext) =>
          providerFactory(model, c, { reasoningEffort: settings.contextReasoningEffort })
      : undefined;

    const queries = await extractSearchQueriesFromContextAndCommand(
      ctx,
      contextProviderFactory,
      context,
      command,
    );

    const { text: rawContext, sources, contents } = await buildRawRetrievedContext(ctx, queries);

    if (sources.length === 0) {
      return {
        block: "## Smart context\n\nNo relevant prior context found.",
        queries,
      };
    }

    if (!contextProviderFactory) {
      return {
        block: `## Smart context\n\n${rawContext}`,
        queries,
      };
    }

    const { sources: filteredSources, contents: filteredContents } = await filterRelevantSources(
      ctx,
      contextProviderFactory,
      command,
      sources,
      contents,
    );

    if (filteredSources.length === 0) {
      return {
        block: "## Smart context\n\nNo relevant prior context found.",
        queries,
      };
    }

    const filteredRawContext = buildRawTextFromChunks(filteredSources, filteredContents);
    const allRetrievedSourceIds = sources.map((s) => s.id);
    const summarizeResult = await summarizeRetrievedContext(
      ctx,
      contextProviderFactory,
      filteredRawContext,
      filteredSources,
      {
        contents: filteredContents,
        userMessage: command,
        allRetrievedSourceIds,
      },
    );

    const block = typeof summarizeResult === "string" ? summarizeResult : summarizeResult.block;

    return {
      block,
      queries,
    };
  },
};
