/**
 * @fileoverview Agent runner: builds tool executor and runs the LLM loop for chat and heartbeat.
 * @module agent/runner
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OllamaMessage } from "@/llm/ollama";
import { ollamaChat, ollamaChatStream } from "@/llm/ollama";
import { runAgentLoop } from "@/llm/run-loop";
import { runSecurityGate } from "@/llm/security-gate";
import { buildAgentSystemPrompt } from "@/prompts";
import {
  createToolExecutor,
  listHeartbeatTools,
  listMaiaTools,
  maiaToolsToOllama,
  type ToolExecutor,
  type AgentRecordForTool,
} from "@/mcp/tools";
import { ollamaWebFetch, ollamaWebSearch } from "@/lib/ollama-web-search";
import { createSandboxFs } from "@/tools/fs";
import { createTerminalRunner } from "@/tools/terminal";
import type { SandboxFs } from "@/tools/fs";

export type AgentRunnerDeps = {
  agentId: string;
  sandboxRoot: string;
  /** Agent's model or fallback to defaultModel */
  model: string;
  defaultModel: string;
  ollamaBaseUrl: string;
  securityGateModel: string;
  /** When set, enables thinking for compatible Ollama models. */
  think?: boolean | "low" | "medium" | "high";
  /** When set, passed to Ollama as options.num_ctx (context length in tokens). */
  num_ctx?: number;
  /** For building system prompt */
  mdContext: Record<string, string>;
  /**
   * When set (e.g. heartbeat task), appended to the system prompt and sent as role "system".
   * Use this for instructions that are not from the user so they are not sent as user messages.
   */
  systemPromptSuffix?: string;
  /** Initial messages (e.g. from conversation history + new user message) */
  messages: OllamaMessage[];
  /** When provided, sendMessageToAgent appends to conversation */
  conversationRepo?: {
    getOrCreate: (agentId: string, type: string, participantId: string | null) => Promise<string>;
  };
  messageRepo?: {
    append: (convId: string, payload: { type: string; role?: string; content?: string | null }, id: string) => Promise<void>;
  };
  timerRepo?: {
    create: (input: { agent_id: string; fire_at_ms: number; repeat_ms: number }) => Promise<string>;
    listByAgent: (agentId: string) => Promise<{ id: string; fire_at_ms: number; repeat_ms: number }[]>;
    delete: (id: string) => Promise<void>;
  };
  agentRepo?: {
    create: (input: { name: string; purpose: string; model?: string | null }) => Promise<{ id: string; name: string; model: string | null; enabled: number }>;
    list: () => Promise<{ id: string; name: string; model: string | null; enabled: number }[]>;
    get: (id: string) => Promise<{ id: string; name: string; model: string | null; enabled: number } | null>;
  };
  memoryRepo?: {
    insert: (agentId: string, content: string) => Promise<string>;
    search: (agentId: string, query: string) => Promise<{ id: string; content: string }[]>;
  };
  /** When set, the final assistant reply is streamed via this callback (for live UI). */
  onChunk?: (text: string) => void;
  /** Max LLM/tool turns per run. Default 20. Use higher for heartbeat so the agent can finish multi-step work. */
  maxTurns?: number;
  /**
   * When set (e.g. for heartbeat), each assistant and tool-result message is persisted to the internal monologue.
   * Enables logging the full autonomous run in one conversation thread.
   */
  onPersistToInternal?: (
    role: "user" | "assistant",
    content: string,
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>
  ) => Promise<void>;
  /**
   * When set (e.g. for heartbeat), fs_read_file for these basenames returns "already in context" instead of reading from disk.
   */
  forbidFsReadFileInWorkspace?: string[];
  /**
   * When set (e.g. HEARTBEAT_OK for heartbeat), run loop stops as soon as assistant content contains this string.
   */
  stopWhenContentContains?: string;
  /**
   * When set (e.g. for heartbeat), the agent can use message_user to post to the user's chat.
   */
  postToUserChat?: (content: string) => Promise<void>;
  /**
   * When set (e.g. for heartbeat), appended after each successful tool result to encourage the model
   * to keep working and use tools; avoids the model treating raw "OK" as the end of the turn.
   */
  toolResultSuccessSuffix?: string;
  /**
   * When set (e.g. "end_heartbeat_turn"), use listHeartbeatTools() and stop the run when this tool is called.
   */
  heartbeatEndTurnToolName?: string;
  /**
   * When true (e.g. user chat), after the first tool execution the run loop injects a reply-phase message
   * and disables tools on the next turn so the agent always ends with a direct reply to the user.
   */
  requireReplyPhaseAfterTools?: boolean;
};

export type RunAgentOutcome =
  | { ok: true; finalContent: string }
  | { ok: false; blocked: true; reason: string }
  | { ok: false; error: string };

/**
 * Builds the tool executor with all wired dependencies for the given agent.
 */
export function buildAgentExecutor(deps: AgentRunnerDeps): ToolExecutor {
  const agentDir = path.join(deps.sandboxRoot, deps.agentId);
  const fs: SandboxFs = createSandboxFs(agentDir);
  const terminal = createTerminalRunner(agentDir);

  const sendMessageToAgent = deps.conversationRepo && deps.messageRepo
    ? async (fromId: string, toId: string, content: string) => {
        const convId = await deps.conversationRepo!.getOrCreate(fromId, "agent_chat", toId);
        await deps.messageRepo!.append(convId, { type: "user", role: "agent", content }, randomUUID());
      }
    : undefined;

  const timerCreate = deps.timerRepo
    ? async (agentId: string, fireAtMs: number, repeatMs: number) =>
        deps.timerRepo!.create({ agent_id: agentId, fire_at_ms: fireAtMs, repeat_ms: repeatMs })
    : undefined;
  const timerList = deps.timerRepo
    ? async (agentId: string) => {
        const list = await deps.timerRepo!.listByAgent(agentId);
        return list.map((t) => ({ id: t.id, fire_at_ms: t.fire_at_ms, repeat_ms: t.repeat_ms }));
      }
    : undefined;
  const timerDelete = deps.timerRepo ? (id: string) => deps.timerRepo!.delete(id) : undefined;

  const agentCreate = deps.agentRepo
    ? async (input: { name: string; purpose: string; model?: string | null }): Promise<AgentRecordForTool> => {
        const created = await deps.agentRepo!.create(input);
        return { id: created.id, name: created.name, model: created.model, enabled: created.enabled === 1 };
      }
    : undefined;
  const agentList = deps.agentRepo
    ? async (): Promise<AgentRecordForTool[]> => {
        const list = await deps.agentRepo!.list();
        return list.map((a) => ({ id: a.id, name: a.name, model: a.model, enabled: a.enabled === 1 }));
      }
    : undefined;
  const agentGet = deps.agentRepo
    ? async (id: string): Promise<AgentRecordForTool | null> => {
        const a = await deps.agentRepo!.get(id);
        if (!a) return null;
        return { id: a.id, name: a.name, model: a.model, enabled: a.enabled === 1 };
      }
    : undefined;

  const memoryInsert = deps.memoryRepo
    ? (agentId: string, content: string) => deps.memoryRepo!.insert(agentId, content)
    : async () => randomUUID();
  const memorySearch = deps.memoryRepo
    ? (agentId: string, query: string) => deps.memoryRepo!.search(agentId, query)
    : async () => [];

  const ollamaApiKey = process.env.OLLAMA_API_KEY?.trim();
  const webSearch = ollamaApiKey
    ? async (query: string, maxResults?: number) => {
        const r = await ollamaWebSearch(query, maxResults);
        return JSON.stringify(r);
      }
    : undefined;
  const webFetch = ollamaApiKey
    ? async (url: string) => {
        const r = await ollamaWebFetch(url);
        return JSON.stringify(r);
      }
    : undefined;

  const rawFsReadFile = (p: string) => fs.readFile(p);
  const fsReadFile = deps.forbidFsReadFileInWorkspace
    ? (p: string) => {
        const base = path.basename(p.trim());
        if (deps.forbidFsReadFileInWorkspace!.includes(base)) {
          return "You already have this file in context; do not re-read it.";
        }
        return rawFsReadFile(p);
      }
    : rawFsReadFile;

  return createToolExecutor({
    agentId: deps.agentId,
    fsList: (p) => fs.list(p),
    fsReadFile,
    fsWriteFile: (p, c) => fs.writeFile(p, c),
    memoryInsert,
    memorySearch,
    sendMessageToAgent,
    postToUserChat: deps.postToUserChat,
    terminalRun: async (command, cwd) => terminal.run(command, { cwd }),
    timerCreate,
    timerList,
    timerDelete,
    agentCreate,
    agentList,
    agentGet,
    webSearch,
    webFetch,
  });
}

/**
 * Runs the agent: system prompt + messages, security gate, Ollama, tools; returns outcome.
 */
export async function runAgent(deps: AgentRunnerDeps): Promise<RunAgentOutcome> {
  let systemPrompt = buildAgentSystemPrompt(deps.mdContext, deps.agentId);
  if (deps.systemPromptSuffix) {
    systemPrompt = systemPrompt + "\n\n" + deps.systemPromptSuffix;
  }
  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    ...deps.messages,
  ];

  const tools = deps.heartbeatEndTurnToolName ? listHeartbeatTools() : listMaiaTools();
  const ollamaTools = maiaToolsToOllama(tools);
  const executor = buildAgentExecutor(deps);

  const securityGate = async (msgs: OllamaMessage[]) => {
    return runSecurityGate(msgs, ollamaChat, {
      baseUrl: deps.ollamaBaseUrl,
      model: deps.securityGateModel,
    });
  };

  try {
    const outcome = await runAgentLoop({
      messages,
      ollamaChat,
      toolExecutor: executor,
      tools: ollamaTools,
      baseUrl: deps.ollamaBaseUrl,
      model: deps.model || deps.defaultModel,
      think: deps.think,
      num_ctx: deps.num_ctx,
      securityGate,
      onChunk: deps.onChunk,
      ollamaChatStream: deps.onChunk
        ? (opts) => ollamaChatStream(opts, fetch)
        : undefined,
      maxTurns: deps.maxTurns,
      onPersistMessage: deps.onPersistToInternal,
      stopWhenContentContains: deps.stopWhenContentContains,
      toolResultSuccessSuffix: deps.toolResultSuccessSuffix,
      heartbeatEndTurnToolName: deps.heartbeatEndTurnToolName,
      requireReplyPhaseAfterTools: deps.requireReplyPhaseAfterTools,
    });

    if (outcome.blocked) {
      return { ok: false, blocked: true, reason: outcome.reason };
    }
    return { ok: true, finalContent: outcome.finalContent };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
