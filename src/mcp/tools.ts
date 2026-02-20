/**
 * @fileoverview MCP-style tool definitions: list and call for Maia internal tools.
 * @module mcp/tools
 */

import { debug, truncateForLog } from "@/lib/logger";

export type McpTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, { type: string; description?: string; items?: unknown } & Record<string, unknown>>;
    required?: string[];
  };
};

/** Ollama tool shape for /api/chat */
export type OllamaToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Converts MCP tool list to Ollama tools format.
 */
export function maiaToolsToOllama(tools: McpTool[]): OllamaToolDef[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

export type ToolCallResult = { content: string; isError?: boolean };

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>
) => Promise<ToolCallResult>;

/**
 * Returns the list of internal tools in MCP format (name, description, inputSchema).
 */
export function listMaiaTools(): McpTool[] {
  return [
    {
      name: "fs_list",
      description: "List directory contents under the sandbox root",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to sandbox (use / for root)" },
        },
        required: ["path"],
      },
    },
    {
      name: "fs_read_file",
      description: "Read file content under the sandbox",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to sandbox" },
        },
        required: ["path"],
      },
    },
    {
      name: "fs_write_file",
      description: "Write content to a file under the sandbox",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "memory_insert",
      description: "Insert a memory chunk for the current agent",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        required: ["content"],
      },
    },
    {
      name: "memory_search",
      description: "Search memory for the current agent",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: "send_message_to_agent",
      description: "Send a message to another agent (appends to the conversation thread with that agent). Use for agent-to-agent only; to message the human user, use message_user instead.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Target agent id" },
          content: { type: "string", description: "Message content" },
        },
        required: ["agent_id", "content"],
      },
    },
    {
      name: "message_user",
      description: "Message the user: post a message to the user's chat so they see it. When instructions say 'message the user', 'tell the user', or 'reach out to the user', use this tool (message_user) with your content. Target is always the user; do not use send_message_to_agent for the user.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Message content to show the user" },
        },
        required: ["content"],
      },
    },
    {
      name: "terminal_run",
      description: "Run a shell command in the agent's sandbox (file commands like ls, cat, cp run via sandbox fs)",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run (e.g. echo hello, ls, cat file.txt)" },
          cwd: { type: "string", description: "Working directory relative to agent sandbox (optional)" },
        },
        required: ["command"],
      },
    },
    {
      name: "timer_create",
      description: "Create a timer for this agent; when it fires the agent runs a heartbeat turn",
      inputSchema: {
        type: "object",
        properties: {
          fire_at_ms: { type: "number", description: "Unix timestamp (ms) when to fire" },
          repeat_ms: { type: "number", description: "If > 0, repeat interval in ms" },
        },
        required: ["fire_at_ms"],
      },
    },
    {
      name: "timer_list",
      description: "List timers for this agent",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "timer_delete",
      description: "Delete a timer by id",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "agent_create",
      description: "Create a new sub-agent (writes IDENTITY.md with purpose)",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          purpose: { type: "string" },
          model: { type: "string" },
        },
        required: ["name", "purpose"],
      },
    },
    {
      name: "agent_list",
      description: "List all agents",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "agent_get",
      description: "Get one agent by id",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "web_search",
      description: "Search the web via Ollama's API. Use for current information.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "number", description: "Max results to return (default 5, max 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "web_fetch",
      description: "Fetch full content of a URL via Ollama's API.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
        },
        required: ["url"],
      },
    },
    {
      name: "submit_plan",
      description:
        "Run a list of tool steps in order. Use this to execute a plan: one call runs all steps and returns combined results. Each step is { tool: string, args: object }. The plan should always end with message_user(your results) so that delivering the result to the user is the final step.",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "Ordered list of steps: [{ tool: string, args: object }, ...]",
            items: {
              type: "object",
              properties: {
                tool: { type: "string" },
                args: { type: "object" },
              },
              required: ["tool"],
            },
          },
        },
        required: ["steps"],
      },
    },
  ];
}

/** Tool name used to end a heartbeat turn. Only exposed when running heartbeat. */
export const END_HEARTBEAT_TURN_TOOL_NAME = "end_heartbeat_turn";

/** Tool definition for ending a heartbeat turn (no args). */
const END_HEARTBEAT_TURN_TOOL: McpTool = {
  name: END_HEARTBEAT_TURN_TOOL_NAME,
  description:
    "Call this when you are finished this turn. Use this tool (not a chat message) to end the turn.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

/**
 * Returns the list of tools for heartbeat runs: all Maia tools plus end_heartbeat_turn.
 * Use this instead of listMaiaTools() when stopWhenContentContains / heartbeat end-turn is used.
 */
export function listHeartbeatTools(): McpTool[] {
  return [...listMaiaTools(), END_HEARTBEAT_TURN_TOOL];
}

/** Terminal run result: allowed + exitCode/stdout/stderr or denied */
export type TerminalRunResult =
  | { allowed: false; reason: string }
  | { allowed: true; exitCode: number; stdout: string; stderr: string };

/** Timer record for list */
export type TimerRecord = { id: string; fire_at_ms: number; repeat_ms: number };

/** Agent record for list/get */
export type AgentRecordForTool = { id: string; name: string; model: string | null; enabled: boolean };

export type ToolExecutorDeps = {
  fsList: (path: string) => { name: string; isDirectory: boolean }[];
  fsReadFile: (path: string) => string;
  fsWriteFile: (path: string, content: string) => void;
  memoryInsert: (agentId: string, content: string) => Promise<string>;
  memorySearch: (agentId: string, query: string) => Promise<{ id: string; content: string }[]>;
  agentId: string;
  sendMessageToAgent?: (fromAgentId: string, toAgentId: string, content: string) => Promise<void>;
  postToUserChat?: (content: string) => Promise<void>;
  terminalRun?: (command: string, cwd?: string) => Promise<TerminalRunResult>;
  timerCreate?: (agentId: string, fireAtMs: number, repeatMs: number) => Promise<string>;
  timerList?: (agentId: string) => Promise<TimerRecord[]>;
  timerDelete?: (timerId: string) => Promise<void>;
  agentCreate?: (input: { name: string; purpose: string; model?: string | null }) => Promise<AgentRecordForTool>;
  agentList?: () => Promise<AgentRecordForTool[]>;
  agentGet?: (id: string) => Promise<AgentRecordForTool | null>;
  webSearch?: (query: string, maxResults?: number) => Promise<string>;
  webFetch?: (url: string) => Promise<string>;
};

/** Max chars for web_search/web_fetch tool results to avoid blowing context. */
const WEB_TOOL_MAX_CONTENT_CHARS = 8000;

function truncateToolContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n[truncated for context length]";
}

/**
 * Known tool names (used to normalize malformed names from the model).
 */
const KNOWN_TOOL_NAMES = [...listMaiaTools().map((t) => t.name), END_HEARTBEAT_TURN_TOOL_NAME];

/**
 * Normalizes tool name so that model output like fs_write_file<|channel|>json or
 * fs_write_file<|channel|>commentary is dispatched as fs_write_file.
 * Some models append special tokens or suffixes to tool names; strip them and match known names.
 */
function normalizeToolName(name: string): string {
  const trimmed = name.trim();
  if (KNOWN_TOOL_NAMES.includes(trimmed)) return trimmed;
  const beforeSpecial = trimmed.includes("<|") ? trimmed.split("<|")[0].trim() : trimmed;
  if (KNOWN_TOOL_NAMES.includes(beforeSpecial)) return beforeSpecial;
  const byPrefix = KNOWN_TOOL_NAMES.find(
    (t) => trimmed.startsWith(t) || beforeSpecial.startsWith(t)
  );
  return byPrefix ?? trimmed;
}

/**
 * Creates a tool executor that dispatches to the given implementations.
 */
function logToolResult(name: string, result: ToolCallResult): void {
  debug("tool", {
    event: "result",
    name,
    isError: result.isError === true,
    contentPreview: truncateForLog(result.content, 200),
  });
}

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  const executor: ToolExecutor = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> => {
    const normalizedName = normalizeToolName(name);
    if (normalizedName !== name) {
      debug("tool", {
        event: "name_normalized",
        from: name,
        to: normalizedName,
      });
    }
    debug("tool", {
      event: "call",
      name: normalizedName,
      agentId: deps.agentId,
      argKeys: Object.keys(args),
      argsPreview: truncateForLog(JSON.stringify(args), 200),
    });
    try {
      switch (normalizedName) {
        case "fs_list": {
          const path = args.path as string;
          const entries = deps.fsList(path ?? "/");
          const result = {
            content: JSON.stringify(
              entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory }))
            ),
          };
          logToolResult(normalizedName, result);
          return result;
        }
        case "fs_read_file": {
          const path = args.path as string;
          const content = deps.fsReadFile(path);
          const result = { content };
          logToolResult(normalizedName, result);
          return result;
        }
        case "fs_write_file": {
          const path = args.path as string;
          const content = args.content as string;
          deps.fsWriteFile(path, content);
          const result = { content: "OK" };
          logToolResult(normalizedName, result);
          return result;
        }
        case "memory_insert": {
          const content = args.content as string;
          const id = await deps.memoryInsert(deps.agentId, content);
          const result = { content: JSON.stringify({ id }) };
          logToolResult(normalizedName, result);
          return result;
        }
        case "memory_search": {
          const query = args.query as string;
          const results = await deps.memorySearch(deps.agentId, query);
          const result = {
            content: JSON.stringify(results.map((r) => ({ id: r.id, content: r.content }))),
          };
          logToolResult(normalizedName, result);
          return result;
        }
        case "send_message_to_agent": {
          const toAgentId = args.agent_id as string;
          const content = args.content as string;
          if (!deps.sendMessageToAgent) {
            const result = { content: "send_message_to_agent not configured", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          await deps.sendMessageToAgent(deps.agentId, toAgentId, content);
          const result = { content: "OK" };
          logToolResult(normalizedName, result);
          return result;
        }
        case "message_user": {
          const content = args.content as string;
          // #region agent log
          fetch("http://127.0.0.1:7245/ingest/13540c59-9d40-405a-a4df-e70acbf0e8f0", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "mcp/tools.ts:message_user",
              message: "message_user tool invoked",
              data: { configured: !!deps.postToUserChat, contentLength: (content ?? "").length },
              timestamp: Date.now(),
              hypothesisId: "msg-user-called",
            }),
          }).catch(() => {});
          // #endregion
          if (!deps.postToUserChat) {
            const result = { content: "message_user not configured", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          await deps.postToUserChat(content ?? "");
          const result = { content: "OK" };
          logToolResult(normalizedName, result);
          return result;
        }
        case END_HEARTBEAT_TURN_TOOL_NAME: {
          const result = { content: "OK" };
          logToolResult(normalizedName, result);
          return result;
        }
        case "submit_plan": {
          const steps = args.steps as Array<{ tool?: string; args?: Record<string, unknown> }> | undefined;
          if (!Array.isArray(steps) || steps.length === 0) {
            const result = { content: "submit_plan requires a non-empty steps array", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          const parts: string[] = [];
          for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const toolName = typeof step === "object" && step !== null && typeof step.tool === "string" ? step.tool : "";
            const stepArgs = typeof step === "object" && step !== null && step.args && typeof step.args === "object" ? step.args : {};
            if (!toolName) {
              parts.push(`Step ${i + 1}: invalid (missing tool)`);
              continue;
            }
            const stepResult = await executor(toolName, stepArgs);
            const text = stepResult.isError ? `[error] ${stepResult.content}` : stepResult.content;
            parts.push(`Step ${i + 1} (${toolName}): ${text}`);
          }
          const result = { content: parts.join("\n\n") };
          logToolResult(normalizedName, result);
          return result;
        }
        case "terminal_run": {
          const command = args.command as string;
          const cwd = args.cwd as string | undefined;
          if (!deps.terminalRun) {
            const result = { content: "terminal not configured", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          const runResult = await deps.terminalRun(command, cwd);
          if (!runResult.allowed) {
            const result = { content: runResult.reason, isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          const out = runResult.stderr ? `${runResult.stdout}\n${runResult.stderr}` : runResult.stdout;
          const result = { content: `exit ${runResult.exitCode}\n${out}` };
          logToolResult(normalizedName, result);
          return result;
        }
        case "timer_create": {
          const fireAtMs = args.fire_at_ms as number;
          const repeatMs = (args.repeat_ms as number) ?? 0;
          if (!deps.timerCreate) {
            const result = { content: "timers not configured", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          const id = await deps.timerCreate(deps.agentId, fireAtMs, repeatMs);
          const result = { content: JSON.stringify({ id }) };
          logToolResult(normalizedName, result);
          return result;
        }
        case "timer_list": {
          if (!deps.timerList) {
            const result = { content: "timers not configured", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          const list = await deps.timerList(deps.agentId);
          const result = { content: JSON.stringify(list) };
          logToolResult(normalizedName, result);
          return result;
        }
        case "timer_delete": {
          const id = args.id as string;
          if (!deps.timerDelete) {
            const result = { content: "timers not configured", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          await deps.timerDelete(id);
          const result = { content: "OK" };
          logToolResult(normalizedName, result);
          return result;
        }
        case "agent_create": {
          const agentName = args.name as string;
          const purpose = args.purpose as string;
          const model = (args.model as string) ?? null;
          if (!deps.agentCreate) {
            const result = { content: "agent CRUD not configured", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          const agent = await deps.agentCreate({ name: agentName, purpose, model });
          const result = { content: JSON.stringify(agent) };
          logToolResult(normalizedName, result);
          return result;
        }
        case "agent_list": {
          if (!deps.agentList) {
            const result = { content: "agent CRUD not configured", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          const agents = await deps.agentList();
          const result = { content: JSON.stringify(agents) };
          logToolResult(normalizedName, result);
          return result;
        }
        case "agent_get": {
          const id = args.id as string;
          if (!deps.agentGet) {
            const result = { content: "agent CRUD not configured", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          const getAgent = await deps.agentGet(id);
          if (!getAgent) {
            const result = { content: "agent not found", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          const result = { content: JSON.stringify(getAgent) };
          logToolResult(normalizedName, result);
          return result;
        }
        case "web_search": {
          if (!deps.webSearch) {
            const result = { content: "web search not configured (set OLLAMA_API_KEY)", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          const query = args.query as string;
          const maxResults = args.max_results as number | undefined;
          const raw = maxResults != null ? Math.min(10, Math.max(1, Math.floor(maxResults))) : 5;
          const content = await deps.webSearch(query ?? "", raw);
          const result = { content: truncateToolContent(content, WEB_TOOL_MAX_CONTENT_CHARS) };
          logToolResult(normalizedName, result);
          return result;
        }
        case "web_fetch": {
          if (!deps.webFetch) {
            const result = { content: "web search not configured (set OLLAMA_API_KEY)", isError: true };
            logToolResult(normalizedName, result);
            return result;
          }
          const url = args.url as string;
          const content = await deps.webFetch(url ?? "");
          const result = { content: truncateToolContent(content, WEB_TOOL_MAX_CONTENT_CHARS) };
          logToolResult(normalizedName, result);
          return result;
        }
        default: {
          const knownTools = listMaiaTools().map((t) => t.name);
          debug("tool", {
            event: "unknown_tool",
            name,
            knownTools,
            hint: "Model may be returning tool name in a different format (e.g. function.name).",
          });
          const result = { content: `Unknown tool: ${name}`, isError: true };
          logToolResult(normalizedName, result);
          return result;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug("tool", { event: "result", name, isError: true, contentPreview: truncateForLog(msg, 200) });
      return { content: msg, isError: true };
    }
  };
  return executor;
}
