import path from "path";
import { createProvider } from "../ai/factory";
import { getSettings } from "../settings";
import { getAgentIdentity, setAgentStatus } from "./identity";
import { getSession, appendEntry, getActiveSessionId } from "../history";
import { getToolsForAgent, getToolByName } from "../tools/registry";
import { compressEntry } from "./compression";
import { SECURITY_PREAMBLE } from "../security/preamble";
import { filterText } from "../security/injection-filter";
import type { HistoryEntry, SSEEvent } from "../types";
import type { Message } from "../ai/types";
import type { ToolContext } from "../tools/types";

export type SSECallback = (event: SSEEvent) => void;

const WORKSPACE_ROOT = path.join(process.cwd(), "data", "workspace");

export async function runAgent(
  agentId: string,
  sessionId: string,
  userMessage: string,
  onEvent: SSECallback
): Promise<void> {
  const settings = getSettings();

  // Load agent
  const agent = getAgentIdentity(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  if (!settings.whitelistedModels.includes(agent.model)) {
    throw new Error(`Agent model not whitelisted: ${agent.model}`);
  }

  setAgentStatus(agentId, "running" as never);

  try {
    await _runLoop(agent, sessionId, userMessage, onEvent, settings);
  } finally {
    setAgentStatus(agentId, "idle" as never);
  }
}

async function _runLoop(
  agent: Awaited<ReturnType<typeof getAgentIdentity>> & object,
  sessionId: string,
  userMessage: string,
  onEvent: SSECallback,
  settings: ReturnType<typeof getSettings>
) {
  const provider = createProvider((agent as { model: string }).model);
  const tools = getToolsForAgent((agent as { id: string }).id);
  const toolDefs = tools.map((t) => t.toDefinition());

  const toolContext: ToolContext = {
    agentId: (agent as { id: string }).id,
    sessionId,
    volumeRoot: path.join(WORKSPACE_ROOT, (agent as { id: string }).id),
  };

  // Store user message (original)
  const userEntry = appendEntry(sessionId, {
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
  });

  // Build context window
  const session = getSession(sessionId);
  const history = session?.compressed ?? [];

  const messages: Message[] = [
    {
      role: "system",
      content: buildSystemPrompt(agent as Parameters<typeof buildSystemPrompt>[0]),
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

  // Agentic loop
  let loopCount = 0;
  const MAX_LOOPS = 10;

  while (loopCount < MAX_LOOPS) {
    loopCount++;

    const response = await provider.complete(messages, toolDefs, (token) => {
      agentResponseContent += token;
      onEvent({ type: "token", content: token });
    });

    // If there are tool calls, execute them
    if (response.toolCalls.length === 0) {
      // Final response — store and done
      agentEntry.content = response.content || agentResponseContent;
      const storedEntry = appendEntry(sessionId, agentEntry);
      await compressEntry(userEntry, sessionId);
      await compressEntry(storedEntry, sessionId);
      onEvent({ type: "done", sessionId, compressed: storedEntry, original: storedEntry });
      break;
    }

    // Execute tool calls
    const toolResults: Message[] = [];
    for (const tc of response.toolCalls) {
      onEvent({ type: "tool_call", tool: tc.name, args: tc.args });

      const tool = tools.find((t) => t.name === tc.name);
      if (!tool) {
        const errorResult = `Tool not found: ${tc.name}`;
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
