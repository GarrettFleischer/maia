/**
 * @fileoverview Node.js-only instrumentation: DB, queue, cron. Imported only when
 * NEXT_RUNTIME === "nodejs" so the queue and its dependencies are not bundled for Edge.
 * @module instrumentation-node
 */
import type { AppContext } from "./lib/context";

/**
 * Registers Node-only services (db, queue, cron) and returns the AppContext.
 * Called from instrumentation.register() only when NEXT_RUNTIME === "nodejs".
 * @returns The initialized AppContext
 */
export async function registerNode(): Promise<AppContext> {
  const { getDb } = await import("./lib/db");
  const {
    makeNodeFsAdapter,
    makeNativeFetchClient,
    makeNodeProcessRunner,
  } = await import("./lib/context");
  const { globalEventBus } = await import("./lib/events");
  const { initMaiaAgent } = await import("./lib/init");

  const ctx: AppContext = {
    db: getDb(),
    fs: makeNodeFsAdapter(),
    http: makeNativeFetchClient(),
    events: globalEventBus,
    processRunner: makeNodeProcessRunner(),
    sandboxContainerName:
      process.env.SANDBOX_CONTAINER_NAME?.trim() || undefined,
  };

  initMaiaAgent(ctx);

  const { runAgent } = await import("./lib/agent/runner");
  const { createProvider } = await import("./lib/ai/factory");
  const { initMessagingService } = await import("./lib/messaging-service");
  const runAgentFn = (
    c: AppContext,
    agentId: string,
    sessionId: string,
    message: string,
    options?: import("./lib/agent/runner").RunAgentOptions,
  ) =>
    runAgent(c, createProvider, agentId, sessionId, message, () => {}, options);

  initMessagingService(ctx, runAgentFn);

  const { registerLlmQueueHandlers } = await import(
    "./lib/queue/llm-queue-handlers"
  );
  registerLlmQueueHandlers();

  const { startQueueProcessor, tickQueueProcessor } = await import(
    "./lib/queue/llm-queue"
  );
  startQueueProcessor(1000);
  tickQueueProcessor();

  const { startCronScheduler } = await import("./lib/cron/service");
  startCronScheduler(ctx, runAgentFn);

  return ctx;
}

export { tickQueueProcessor } from "./lib/queue/llm-queue";
