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
import { getMatchedSkillsContent } from "../skills";
import type { Tool, ToolContext } from "./types";

const schema = z.object({
  ctx: z
    .string()
    .describe("What to base search on (e.g. user question, prior discussion)"),
  cmd: z.string().describe("What you want to accomplish with this search"),
});

export const smartContextTool: Tool<z.infer<typeof schema>> = {
  name: "smart_context",
  description:
    "Query history and knowledge base using context and command. Generates search queries from your context, retrieves relevant history and knowledge entries, filters and summarizes them. Prefer this over knowledge_search and history_semantic_search when you need to access prior knowledge or session history—it produces better, focused results. Example: smart_context({ ctx: 'user asked about deployment', cmd: 'find past discussions' }).",
  schema,
  toDefinition: () => ({
    name: "smart_context",
    description:
      "Query history and knowledge base using context and command. Generates search queries from your context, retrieves relevant history and knowledge entries, filters and summarizes them. Prefer this over knowledge_search and history_semantic_search when you need to access prior knowledge or session history—it produces better, focused results. Example: smart_context({ ctx: 'user asked about deployment', cmd: 'find past discussions' }).",
    parameters: zodToJsonSchema(schema),
  }),
  execute: async ({ ctx: context, cmd: command }, ctx) => {
    const settings = getSettings(ctx);
    const providerFactory = ctx.providerFactory;

    const contextProviderFactory = providerFactory
      ? (model: string, c: AppContext) =>
          providerFactory(model, c, {
            reasoningEffort: settings.contextReasoningEffort,
          })
      : undefined;

    const queries = await extractSearchQueriesFromContextAndCommand(
      ctx,
      contextProviderFactory,
      context,
      command,
    );

    const skillsQuery = [context, command]
      .filter((value) => value && value.trim().length > 0)
      .join("\n\n");
    const skillsResult = await getMatchedSkillsContent(
      ctx,
      ctx.agentId,
      skillsQuery,
      { providerFactory: contextProviderFactory },
    );

    function buildBlockWithSourcesAndSkills(
      summaryBlock: string,
      sourceIds: string[],
      skillNames: string[],
      fullSkillsContent: string,
    ): string {
      const sourcesSection =
        "\n\n### Sources\n" +
        (sourceIds.length > 0
          ? sourceIds.map((id) => `- ${id}`).join("\n")
          : "(none)");
      const skillsSection =
        "\n\n### Skills\n" +
        (skillNames.length > 0
          ? skillNames.map((n) => `- ${n}`).join("\n")
          : "(none)");
      let out = summaryBlock.trimEnd() + sourcesSection + skillsSection;
      if (fullSkillsContent && fullSkillsContent.trim()) {
        out += "\n\n" + fullSkillsContent.trim();
      }
      return out;
    }

    const {
      text: rawContext,
      sources,
      contents,
    } = await buildRawRetrievedContext(ctx, queries);

    if (sources.length === 0) {
      return {
        block: buildBlockWithSourcesAndSkills(
          "## Smart context\n\nNo relevant prior context found.",
          [],
          skillsResult.skillNames,
          skillsResult.content,
        ),
        queries,
      };
    }

    if (!contextProviderFactory) {
      return {
        block: buildBlockWithSourcesAndSkills(
          `## Smart context\n\n${rawContext}`,
          sources.map((s) => s.id),
          skillsResult.skillNames,
          skillsResult.content,
        ),
        queries,
      };
    }

    const { sources: filteredSources, contents: filteredContents } =
      await filterRelevantSources(
        ctx,
        contextProviderFactory,
        command,
        sources,
        contents,
      );

    if (filteredSources.length === 0) {
      return {
        block: buildBlockWithSourcesAndSkills(
          "## Smart context\n\nNo relevant prior context found.",
          [],
          skillsResult.skillNames,
          skillsResult.content,
        ),
        queries,
      };
    }

    const filteredRawContext = buildRawTextFromChunks(
      filteredSources,
      filteredContents,
    );
    const allRetrievedSourceIds = sources.map((s) => s.id);
    const summarizeResult = await summarizeRetrievedContext(
      ctx,
      contextProviderFactory,
      filteredRawContext,
      filteredSources,
      {
        contents: filteredContents,
        userMessage: command,
        searchQueries: queries,
        allRetrievedSourceIds,
      },
    );

    const block =
      typeof summarizeResult === "string"
        ? summarizeResult
        : summarizeResult.block;
    const sourceIds = filteredSources.map((s) => s.id);

    return {
      block: buildBlockWithSourcesAndSkills(
        block,
        sourceIds,
        skillsResult.skillNames,
        skillsResult.content,
      ),
      queries,
    };
  },
};
