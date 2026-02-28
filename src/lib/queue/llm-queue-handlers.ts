/**
 * @fileoverview Tool handlers for the LLM queue. Registers handlers for each queueable tool.
 * @module lib/queue/llm-queue-handlers
 *
 * Import this module at startup (e.g. in instrumentation) to register handlers before any jobs run.
 */

import { registerToolHandler, _markHandlersRegistered } from "./llm-queue";
import type { AppContext } from "../context";
import type { ContextSource } from "../agent/context-query";
import type { RunAgentOptions } from "../agent/runner";

/**
 * Registers all tool handlers. Call once at startup.
 */
export function registerLlmQueueHandlers(): void {
  registerToolHandler("refreshEmbeddings", async (ctx) => {
    const { refreshEmbeddings } = await import("../knowledge/refresh-embeddings");
    await refreshEmbeddings(ctx);
  });

  registerToolHandler("runKnowledgeIndex", async (ctx) => {
    const { runKnowledgeIndex } = await import("../knowledge/index");
    const { createEmbeddingAdapter } = await import("../knowledge/embedding");
    const { getSettings } = await import("../settings");
    await runKnowledgeIndex(ctx, {
      embedder: createEmbeddingAdapter(getSettings(ctx), ctx.http),
    });
  });

  registerToolHandler("buildRawRetrievedContext", async (ctx, args) => {
    const { buildRawRetrievedContext } = await import("../agent/context-query");
    const queries = args.queries as string[];
    return buildRawRetrievedContext(ctx, queries);
  });

  registerToolHandler("indexHistoryEntry", async (ctx, args) => {
    const { indexHistoryEntry } = await import("../knowledge/history-index");
    const entryId = args.entryId as string;
    await indexHistoryEntry(ctx, entryId);
  });

  registerToolHandler("extractSearchQueries", async (ctx, args) => {
    const { extractSearchQueries } = await import("../agent/context-query");
    const { createProvider } = await import("../ai/factory");
    const { getSettings } = await import("../settings");
    const userMessage = args.userMessage as string;
    const recentThreadBlock = args.recentThreadBlock as string | undefined;
    const providerFactory =
      (args.providerFactory as (model: string, c: AppContext) => import("../ai/types").AIProvider) ??
      ((model: string, c: AppContext) =>
        createProvider(model, c, {
          reasoningEffort: getSettings(ctx).contextReasoningEffort,
        }));
    return extractSearchQueries(ctx, providerFactory, userMessage, recentThreadBlock);
  });

  registerToolHandler("filterRelevantSources", async (ctx, args) => {
    const { filterRelevantSources } = await import("../agent/context-query");
    const { createProvider } = await import("../ai/factory");
    const { getSettings } = await import("../settings");
    const userMessage = args.userMessage as string;
    const sources = args.sources as ContextSource[];
    const contents = args.contents as string[];
    const providerFactory =
      (args.providerFactory as (model: string, c: AppContext) => import("../ai/types").AIProvider) ??
      ((model: string, c: AppContext) =>
        createProvider(model, c, {
          reasoningEffort: getSettings(ctx).contextReasoningEffort,
        }));
    return filterRelevantSources(ctx, providerFactory, userMessage, sources, contents);
  });

  registerToolHandler("summarizeRetrievedContext", async (ctx, args) => {
    const { summarizeRetrievedContext } = await import("../agent/context-query");
    const { createProvider } = await import("../ai/factory");
    const { getSettings } = await import("../settings");
    const rawText = args.rawText as string;
    const sources = args.sources as ContextSource[];
    const options = args.options as {
      contents?: string[];
      userMessage?: string;
      allRetrievedSourceIds?: string[];
    };
    const providerFactory =
      (args.providerFactory as (model: string, c: AppContext) => import("../ai/types").AIProvider) ??
      ((model: string, c: AppContext) =>
        createProvider(model, c, {
          reasoningEffort: getSettings(ctx).contextReasoningEffort,
        }));
    return summarizeRetrievedContext(ctx, providerFactory, rawText, sources, options);
  });

  registerToolHandler("runAgent", async (ctx, args) => {
    const agentId = args.agentId as string;
    const sessionId = args.sessionId as string;
    const message = args.message as string;
    const queueCaller = args.queueCaller as "user" | "maia" | "agent" | undefined;
    const options: RunAgentOptions = {
      ...(args.options as RunAgentOptions | undefined),
      queueCaller,
      // Run smart context inline to avoid deadlock: this handler is the single queue worker.
      smartContextViaQueue: false,
    };
    const runAgentFn = args.runAgentFn as ((c: typeof ctx, a: string, s: string, m: string, o?: RunAgentOptions) => Promise<string>) | undefined;
    if (runAgentFn) {
      return runAgentFn(ctx, agentId, sessionId, message, options);
    }
    const { runAgent } = await import("../agent/runner");
    const { createProvider } = await import("../ai/factory");
    const onEvent = (args.onEvent as ((event: unknown) => void) | undefined) ?? (() => {});
    return runAgent(ctx, createProvider, agentId, sessionId, message, onEvent, options);
  });

  registerToolHandler("rebuildEmbeddings", async (ctx) => {
    const { rebuildEmbeddings } = await import("../knowledge/rebuild-embeddings");
    return rebuildEmbeddings(ctx);
  });

  registerToolHandler("buildEmbeddings", async (ctx) => {
    const { buildEmbeddings } = await import("../knowledge/rebuild-embeddings");
    return buildEmbeddings(ctx);
  });

  /**
   * Executes any registered agent or custom tool by name.
   * Use to enqueue agent tools (e.g. knowledge_search, message_send) or custom tools from manifests.
   * Args: toolName (string), toolArgs (Record<string, unknown>), agentId?, sessionId?, volumeRoot?
   */
  registerToolHandler("executeTool", async (ctx, args) => {
    const { getToolByName, getToolsForAgent } = await import("../tools/registry");
    const { getAgentDir } = await import("../data-dir");
    const toolName = args.toolName as string;
    const toolArgs = (args.toolArgs ?? {}) as Record<string, unknown>;
    const agentId = (args.agentId as string) ?? "maia";
    const sessionId = (args.sessionId as string) ?? "";
    const volumeRoot = (args.volumeRoot as string) ?? getAgentDir(agentId);
    const tool = getToolByName(toolName);
    if (!tool) throw new Error(`Queue: tool not found: ${toolName}`);
    const toolContext = {
      ...ctx,
      agentId,
      sessionId,
      volumeRoot,
      getToolsForAgent,
    };
    const parsed = tool.schema.safeParse(toolArgs);
    if (!parsed.success) {
      throw new Error(
        `Queue executeTool ${toolName}: invalid args: ${parsed.error.message}`,
      );
    }
    return tool.execute(parsed.data, toolContext);
  });

  /** For tests: runs args.exec() when provided. */
  registerToolHandler("test", async (_ctx, args) => {
    const exec = args.exec as (() => Promise<unknown>) | undefined;
    if (typeof exec !== "function") throw new Error("test tool requires args.exec");
    return exec();
  });

  _markHandlersRegistered();
}
