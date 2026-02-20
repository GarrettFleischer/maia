/**
 * @fileoverview Builds heartbeat runner deps with real runAgentTurn (Ollama + tools + persist).
 * @module heartbeat/deps
 */

import { runAgent } from "@/agent/runner";
import { createAgentRepository } from "@/db/agents";
import { createConversationRepository } from "@/db/conversations";
import { createMessageRepository } from "@/db/messages";
import { createMemoryRepository } from "@/db/memory";
import { createTimerRepository } from "@/db/timers";
import type { DbClient } from "@/db/client";
import type { RunHeartbeatOnceDeps } from "@/heartbeat/runner";
import type { OllamaMessage } from "@/llm/ollama";
import { debug } from "@/lib/logger";
import { randomUUID } from "node:crypto";
import type { FsDeps } from "@/db/agents";
import { broadcast } from "@/lib/conversation-events";
import { parseOllamaNumCtx, parseOllamaThink } from "@/lib/ollama-env";
import { buildHeartbeatPrompt, HEARTBEAT_OK, HEARTBEAT_TOOL_RESULT_CONTINUATION } from "@/prompts";
import { END_HEARTBEAT_TURN_TOOL_NAME } from "@/mcp/tools";

/** Max number of most recent user_chat messages to include in heartbeat context so the agent knows what it said and if it is waiting for a reply. */
const LAST_USER_CHAT_MESSAGES = 10;

/**
 * Extracts content from narrative text like [Tools: message_user({"content":"..."})] or
 * message_user({\"content\":\"...\"}) when the model describes tool calls instead of using structured tool_calls.
 * Returns the first match; supports escaped quotes in the content string.
 */
function extractMessageUserContentFromText(text: string): string | null {
  const re = /\bmessage_user\s*\(\s*\{[^}]*(?:"content"|\\"content\\")\s*:\s*(?:"|\\")((?:[^"\\]|\\.)*?)(?:"|\\")/;
  const m = text.match(re);
  if (!m) return null;
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export type CreateHeartbeatDepsOptions = {
  db: DbClient;
  sandboxRoot: string;
  fs: FsDeps;
  ollamaBaseUrl?: string;
  defaultModel?: string;
  securityGateModel?: string;
  /** When set, enables thinking for compatible Ollama models. Default: from OLLAMA_THINK / OLLAMA_THINK_LEVEL. */
  ollamaThink?: boolean | "low" | "medium" | "high";
  /** When set, context length in tokens (Ollama options.num_ctx). Default: from OLLAMA_NUM_CTX. */
  ollamaNumCtx?: number;
};

/**
 * Creates deps for runHeartbeatOnce with runAgentTurn that runs the real agent and persists to internal conversation.
 */
export function createHeartbeatDeps(
  options: CreateHeartbeatDepsOptions
): RunHeartbeatOnceDeps {
  const {
    db,
    sandboxRoot,
    fs,
    ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    defaultModel = process.env.OLLAMA_DEFAULT_MODEL ?? "llama3",
    securityGateModel = process.env.OLLAMA_SECURITY_GATE_MODEL ?? "llama3",
    ollamaThink = parseOllamaThink(),
    ollamaNumCtx = parseOllamaNumCtx(),
  } = options;

  const agentRepo = createAgentRepository(db, sandboxRoot, fs);
  const convRepo = createConversationRepository(db);
  const msgRepo = createMessageRepository(db);
  const timerRepo = createTimerRepository(db);
  const memoryRepo = createMemoryRepository(db);

  return {
    sandboxRoot,
    listEnabledAgents: () =>
      agentRepo.list().then((list) => list.filter((a) => a.enabled === 1)),
    runAgentTurn: async (agentId: string, context: Record<string, string>) => {
      const convId = await convRepo.getOrCreate(agentId, "internal", null);
      const existing = await msgRepo.listByConversation(convId);
      const last = existing[existing.length - 1];
      const lastIsRecent =
        last?.role === "assistant" &&
        last.created_at != null &&
        Date.now() - last.created_at < 90_000;
      if (
        lastIsRecent &&
        last?.content != null &&
        !last.content.includes(HEARTBEAT_OK)
      ) {
        debug("heartbeat", {
          event: "skip_agent_busy",
          agentId,
          reason: "last run did not end with HEARTBEAT_OK",
        });
        return;
      }
      const lastRunSummary = (() => {
        for (let i = existing.length - 1; i >= 0; i--) {
          const m = existing[i];
          if (m?.role === "assistant" && m.content != null && m.content.length > 0) {
            const snippet = m.content.includes(HEARTBEAT_OK)
              ? "replied HEARTBEAT_OK"
              : m.content.length > 120
                ? m.content.slice(0, 117) + "..."
                : m.content;
            return `Last run you: ${snippet}\n\n`;
          }
        }
        return "";
      })();
      const heartbeatPrompt = buildHeartbeatPrompt(lastRunSummary);
      const userChatConvId = await convRepo.getOrCreate(agentId, "user_chat", null);
      const userChatMessages = await msgRepo.listByConversation(userChatConvId);
      const lastUserChat = userChatMessages.slice(-LAST_USER_CHAT_MESSAGES);
      const recentUserChatBlock =
        lastUserChat.length > 0
          ? "Recent user chat (so you know what you already said and whether you are waiting for a reply):\n" +
            lastUserChat
              .map((m) => {
                const label = (m.role ?? m.type) === "user" ? "User" : "You (to user)";
                return `${label}: ${(m.content ?? "").trim().replace(/\n/g, " ").slice(0, 500)}`;
              })
              .join("\n")
          : "";
      const systemPromptSuffix =
        recentUserChatBlock.length > 0
          ? heartbeatPrompt + "\n\n" + recentUserChatBlock
          : heartbeatPrompt;
      debug("heartbeat", {
        event: "heartbeat_prompt",
        agentId,
        convId,
        promptLength: heartbeatPrompt.length,
        recentUserChatCount: lastUserChat.length,
      });
      await msgRepo.append(convId, { type: "user", role: "user", content: heartbeatPrompt }, randomUUID());
      /** Include only the previous run; current task is sent as system (systemPromptSuffix), not as user. */
      const prevRunStartIndex = (() => {
        for (let i = existing.length - 1; i >= 0; i--) {
          if (existing[i]?.role === "user") return i;
        }
        return 0;
      })();
      const previousRunMessages = existing.slice(prevRunStartIndex);
      const ollamaMessages: OllamaMessage[] = previousRunMessages
        .filter((m) => m.type === "user" || m.type === "assistant")
        .map((m) => ({
          role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
          content: m.content ?? "",
        }));

      const agent = await agentRepo.get(agentId);
      if (!agent || agent.enabled !== 1) return;

      const onPersistToInternal = async (
        role: "user" | "assistant",
        content: string
      ) => {
        await msgRepo.append(
          convId,
          {
            type: role,
            role,
            content,
          },
          randomUUID()
        );
        broadcast(convId);
      };

      const postToUserChatImpl = async (content: string) => {
        // #region agent log
        fetch("http://127.0.0.1:7245/ingest/13540c59-9d40-405a-a4df-e70acbf0e8f0", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "heartbeat/deps.ts:postToUserChat",
            message: "message_user: appending to user_chat",
            data: { agentId, userChatConvId, contentLength: content.length, contentPreview: content.slice(0, 80) },
            timestamp: Date.now(),
            hypothesisId: "msg-user-flow",
          }),
        }).catch(() => {});
        // #endregion
        await msgRepo.append(
          userChatConvId,
          { type: "assistant", role: "assistant", content },
          randomUUID()
        );
        broadcast(userChatConvId);
      };

      const outcome = await runAgent({
        agentId,
        sandboxRoot,
        model: agent.model ?? defaultModel,
        defaultModel,
        ollamaBaseUrl,
        securityGateModel,
        think: ollamaThink,
        num_ctx: ollamaNumCtx,
        mdContext: context,
        systemPromptSuffix,
        messages: ollamaMessages,
        conversationRepo: convRepo,
        messageRepo: msgRepo,
        timerRepo,
        agentRepo: {
          create: (input) => agentRepo.create(input),
          list: () => agentRepo.list(),
          get: (id) => agentRepo.get(id),
        },
        memoryRepo,
        maxTurns: 50,
        onPersistToInternal,
        forbidFsReadFileInWorkspace: ["HEARTBEAT.md", "SOUL.md"],
        stopWhenContentContains: HEARTBEAT_OK,
        postToUserChat: postToUserChatImpl,
        toolResultSuccessSuffix: HEARTBEAT_TOOL_RESULT_CONTINUATION,
        heartbeatEndTurnToolName: END_HEARTBEAT_TURN_TOOL_NAME,
      });
      if (outcome.ok && outcome.finalContent) {
        const extracted = extractMessageUserContentFromText(outcome.finalContent);
        if (extracted) await postToUserChatImpl(extracted);
      }
    },
  };
}
