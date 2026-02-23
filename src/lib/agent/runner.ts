import path from "path";
import { getSettings } from "../settings";
import { getAgentIdentity, setAgentStatus } from "./identity";
import { getSession, appendEntry } from "../history";
import { getToolsForAgent } from "../tools/registry";
import { compressEntry } from "./compression";
import { indexHistoryEntry } from "../knowledge/history-index";
import { SECURITY_PREAMBLE } from "../security/preamble";
import { filterText } from "../security/injection-filter";
import type { AppContext } from "../context";
import type { AIProvider } from "../ai/types";
import type { HistoryEntry, SSEEvent } from "../types";
import type { Message } from "../ai/types";
import type { ToolContext } from "../tools/types";
import { getWorkspaceRoot } from "../data-dir";

export type SSECallback = (event: SSEEvent) => void;
export type ProviderFactory = (model: string, ctx: AppContext) => AIProvider;

const WORKSPACE_ROOT = getWorkspaceRoot();

export async function runAgent(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  agentId: string,
  sessionId: string,
  userMessage: string,
  onEvent: SSECallback
): Promise<void> {
  const settings = getSettings(ctx);

  // Load agent
  const agent = getAgentIdentity(ctx, agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  if (!settings.whitelistedModels.includes(agent.model)) {
    throw new Error(`Model not whitelisted: ${agent.model}`);
  }

  setAgentStatus(ctx, agentId, "running");

  try {
    await _runLoop(ctx, providerFactory, agent, sessionId, userMessage, onEvent, settings);
  } finally {
    setAgentStatus(ctx, agentId, "idle");
  }
}

async function _runLoop(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  agent: NonNullable<Awaited<ReturnType<typeof getAgentIdentity>>>,
  sessionId: string,
  userMessage: string,
  onEvent: SSECallback,
  settings: ReturnType<typeof getSettings>
) {
  const provider = providerFactory(agent.model, ctx);
  const tools = getToolsForAgent(agent.id);
  const toolDefs = tools.map((t) => t.toDefinition());

  const toolContext: ToolContext = {
    ...ctx,
    agentId: agent.id,
    sessionId,
    volumeRoot: path.join(WORKSPACE_ROOT, agent.id),
  };

  // Store user message (original)
  const userEntry = appendEntry(ctx, sessionId, {
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
  });
  indexHistoryEntry(ctx, userEntry.id).catch((err) =>
    console.error("History index (user entry) failed:", err)
  );

  // Build context window
  const session = getSession(ctx, sessionId);
  const history = session?.compressed ?? [];

  const messages: Message[] = [
    {
      role: "system",
      content: buildSystemPrompt(agent),
    },
    // Compressed history (all but the last entry which is the current user msg)
    ...history.slice(0, -1).map(entryToMessage),
    // Current user message (original)
    { role: "user", content: userMessage },
  ];

  let agentResponseContent = "";
  const agentEntry: Omit<HistoryEntry, "id"> = {
    role: "agent",
    content: "",
    timestamp: new Date().toISOString(),
  };

  // Compression provider: try to create one, null means fallback to as-is
  let compressionProvider: AIProvider | null = null;
  try {
    compressionProvider = providerFactory(settings.compressionModel, ctx);
  } catch { /* model not whitelisted or not configured — compression disabled */ }

  // Agentic loop
  let loopCount = 0;
  const MAX_LOOPS = 10;

  while (loopCount < MAX_LOOPS) {
    loopCount++;

    const response = await provider.complete(messages, toolDefs, (token) => {
      agentResponseContent += token;
      onEvent({ type: "token", content: token });
    });

    // If there are no tool calls, this is the final response
    if (response.toolCalls.length === 0) {
      agentEntry.content = response.content || agentResponseContent;
      const storedEntry = appendEntry(ctx, sessionId, agentEntry);
      indexHistoryEntry(ctx, storedEntry.id).catch((err) =>
        console.error("History index (agent entry) failed:", err)
      );
      const compressedUser = await compressEntry(ctx, compressionProvider, userEntry, sessionId);
      indexHistoryEntry(ctx, compressedUser.id).catch((err) =>
        console.error("History index (compressed user) failed:", err)
      );
      const compressedStored = await compressEntry(ctx, compressionProvider, storedEntry, sessionId);
      indexHistoryEntry(ctx, compressedStored.id).catch((err) =>
        console.error("History index (compressed agent) failed:", err)
      );
      onEvent({ type: "done", sessionId, compressed: storedEntry, original: storedEntry });
      break;
    }

    // Execute tool calls
    const toolResults: Message[] = [];
    for (const tc of response.toolCalls) {
      onEvent({ type: "tool_call", tool: tc.name, args: tc.args });

      const tool = tools.find((t) => t.name === tc.name);
      if (!tool) {
        const errorResult = `Unknown tool: ${tc.name}`;
        onEvent({ type: "tool_result", tool: tc.name, result: { error: errorResult } });
        toolResults.push({ role: "tool", content: JSON.stringify({ error: errorResult }), toolCallId: tc.id, toolName: tc.name });
        continue;
      }

      try {
        // Validate args with Zod
        const parsed = tool.schema.parse(tc.args);
        const result = await tool.execute(parsed, toolContext);

        // Filter result for injection
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        const filtered = filterText(resultStr, `tool:${tc.name}`);

        onEvent({ type: "tool_result", tool: tc.name, result: filtered.text });
        toolResults.push({
          role: "tool",
          content: filtered.text,
          toolCallId: tc.id,
          toolName: tc.name,
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        onEvent({ type: "tool_result", tool: tc.name, result: { error: errorMsg } });
        toolResults.push({
          role: "tool",
          content: JSON.stringify({ error: errorMsg }),
          toolCallId: tc.id,
          toolName: tc.name,
        });
      }
    }

    // Append assistant response + tool results to messages, loop again
    messages.push({ role: "assistant", content: response.content || agentResponseContent });
    messages.push(...toolResults);
    agentResponseContent = "";
  }

  if (loopCount >= MAX_LOOPS) {
    onEvent({ type: "error", message: "Agent reached maximum tool call loop limit" });
  }
}

function buildSystemPrompt(agent: {
  soul: string;
  memory: string;
  goals: string;
  user: string;
  systemPromptExtra?: string;
}): string {
  return [
    SECURITY_PREAMBLE,
    "",
    "## Identity",
    agent.soul,
    "",
    "## Memory",
    agent.memory,
    "",
    "## Goals",
    agent.goals,
    "",
    "## User",
    agent.user,
    agent.systemPromptExtra ? `\n## Additional Instructions\n${agent.systemPromptExtra}` : "",
  ]
    .filter((s) => s !== undefined)
    .join("\n");
}

function entryToMessage(entry: HistoryEntry): Message {
  return {
    role: entry.role === "agent" ? "assistant" : entry.role === "user" ? "user" : "user",
    content: entry.content,
  };
}
