/**
 * @fileoverview Agent run loop: security gate, Ollama chat, tool execution until done.
 * @module llm/run-loop
 */

import type { OllamaChatOptions, OllamaChatResponse, OllamaMessage, OllamaStreamChunk } from "@/llm/ollama";
import type { ToolCallResult, ToolExecutor } from "@/mcp/tools";
import { debug, truncateForLog } from "@/lib/logger";
import {
  formatToolCallMissingNameError,
  HEARTBEAT_OK,
  RUN_LOOP_REPEATED_TOOL_CALL_MESSAGE,
  RUN_LOOP_REPLY_PHASE_MESSAGE,
  RUN_LOOP_TOOL_ERROR_FOLLOWUP,
} from "@/prompts";

/** Max times the same tool (by name) can be called in one run; prevents e.g. web_search loops. */
const MAX_SAME_TOOL_CALLS_PER_RUN = 4;

export type SecurityGateResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export type RunLoopDeps = {
  /** Current messages (system + user/assistant). Will be mutated with tool results. */
  messages: OllamaMessage[];
  ollamaChat: (opts: OllamaChatOptions) => Promise<OllamaChatResponse>;
  toolExecutor: ToolExecutor;
  tools: OllamaChatOptions["tools"];
  baseUrl: string;
  model: string;
  /** When set, passed to Ollama as the "think" option for compatible models. */
  think?: OllamaChatOptions["think"];
  /** When set, passed to Ollama as options.num_ctx (context length in tokens). */
  num_ctx?: number;
  /** Called before each LLM request. Return allowed: false to block and inject block message. */
  securityGate: (messages: OllamaMessage[]) => Promise<SecurityGateResult>;
  /** Max turns to avoid infinite tool loops */
  maxTurns?: number;
  /** When set with ollamaChatStream, content deltas from the LLM are passed here (for live UI). */
  onChunk?: (text: string) => void;
  /** When set with onChunk, used instead of ollamaChat for the LLM call so content can be streamed. */
  ollamaChatStream?: (opts: OllamaChatOptions) => AsyncGenerator<OllamaStreamChunk>;
  /**
   * When set (e.g. for heartbeat), each assistant and tool-result message is persisted to the internal monologue.
   * Called with role, content, and optional toolCalls so the full run is logged in one conversation.
   */
  onPersistMessage?: (
    role: "user" | "assistant",
    content: string,
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>
  ) => Promise<void>;
  /** When set (e.g. HEARTBEAT_OK), if assistant content contains this string, treat run as done and return immediately. */
  stopWhenContentContains?: string;
  /**
   * When set (e.g. for heartbeat), appended after each successful tool result so the model is encouraged
   * to keep working and use tools instead of treating the raw "OK" as the end of the turn.
   */
  toolResultSuccessSuffix?: string;
  /**
   * When set (e.g. "end_heartbeat_turn"), if the assistant calls this tool we stop the run without
   * executing it and return done. Use with listHeartbeatTools() so the model can end the turn via tool.
   */
  heartbeatEndTurnToolName?: string;
  /**
   * When true (e.g. user chat), after the first tool execution we inject a "reply to the user" message
   * and pass no tools on the next turn so the run always ends with a direct reply.
   */
  requireReplyPhaseAfterTools?: boolean;
};

export type RunLoopOutcome =
  | { done: true; finalContent: string; blocked?: false }
  | { done: true; blocked: true; reason: string };

/**
 * Runs the agent loop: security check -> Ollama -> if tool_calls execute tools and repeat.
 */
export async function runAgentLoop(deps: RunLoopDeps): Promise<RunLoopOutcome> {
  const maxTurns = deps.maxTurns ?? 20;
  let turns = 0;
  let messages = [...deps.messages];
  /** When set, next LLM call uses this instead of deps.tools (e.g. [] to force reply-only turn). */
  let toolsOverride: RunLoopDeps["tools"] | undefined = undefined;
  /** True after we've executed at least one tool and requireReplyPhaseAfterTools is set. */
  let replyPhaseScheduled = false;

  while (turns < maxTurns) {
    turns++;
    debug("run_loop", { event: "turn_start", turn: turns, maxTurns });
    const gate = await deps.securityGate(messages);
    if (!gate.allowed) {
      debug("run_loop", { event: "blocked", reason: gate.reason });
      return { done: true, blocked: true, reason: gate.reason };
    }

    const toolsToUse = toolsOverride !== undefined ? toolsOverride : deps.tools;
    let msg: { role: string; content: string; tool_calls?: { name: string; arguments: Record<string, unknown> }[] };
    if (deps.ollamaChatStream && deps.onChunk) {
      msg = { role: "assistant", content: "" };
      let streamedContent = "";
      for await (const chunk of deps.ollamaChatStream({
        baseUrl: deps.baseUrl,
        model: deps.model,
        messages,
        tools: toolsToUse,
        think: deps.think,
        num_ctx: deps.num_ctx,
      })) {
        if ("delta" in chunk) {
          streamedContent += chunk.delta;
          deps.onChunk(chunk.delta);
        }
        if ("done" in chunk && chunk.done && chunk.message) {
          msg = chunk.message;
          if (!(msg.content ?? "").trim() && streamedContent.length > 0) {
            msg = { ...msg, content: streamedContent };
          }
        }
      }
    } else {
      const res = await deps.ollamaChat({
        baseUrl: deps.baseUrl,
        model: deps.model,
        messages,
        tools: toolsToUse,
        think: deps.think,
        num_ctx: deps.num_ctx,
      });
      msg = res.message;
    }
    const content = msg.content ?? "";
    // #region agent log
    fetch("http://127.0.0.1:7245/ingest/13540c59-9d40-405a-a4df-e70acbf0e8f0", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e87760" },
      body: JSON.stringify({
        sessionId: "e87760",
        location: "run-loop.ts:after-msg",
        message: "Assistant message received",
        data: {
          turn: turns,
          contentLength: content.length,
          contentPreview: content.slice(0, 400),
          hasToolCalls: !!(msg.tool_calls && msg.tool_calls.length > 0),
          toolCallCount: msg.tool_calls?.length ?? 0,
          contentLooksLikeToolCall: /^\s*\{\s*"tool"\s*:/.test(content) && /"arguments"\s*:/.test(content),
        },
        timestamp: Date.now(),
        hypothesisId: "H1",
      }),
    }).catch(() => {});
    // #endregion
    if (
      deps.stopWhenContentContains != null &&
      content.includes(deps.stopWhenContentContains)
    ) {
      debug("run_loop", {
        event: "done",
        turn: turns,
        contentLength: content.length,
        stopWhen: deps.stopWhenContentContains,
      });
      if (deps.onPersistMessage) {
        await deps.onPersistMessage("assistant", content);
      }
      return { done: true, finalContent: content };
    }
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const toolNames = msg.tool_calls.map((tc) => tc.name ?? "(missing)");
      debug("run_loop", {
        event: "tool_calls",
        turn: turns,
        toolNames,
        count: msg.tool_calls.length,
      });
      const prevAssistant = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i] as { role?: string; tool_calls?: { name?: string; arguments?: unknown }[] };
          if (m.role === "assistant") return m;
        }
        return null;
      })();
      const sameAsPrev =
        prevAssistant?.tool_calls != null &&
        prevAssistant.tool_calls.length === msg.tool_calls.length &&
        msg.tool_calls.every((tc, i) => {
          const p = prevAssistant.tool_calls?.[i];
          return (
            p != null &&
            (p.name ?? "") === (tc.name ?? "") &&
            JSON.stringify(p.arguments ?? {}) === JSON.stringify(tc.arguments ?? {})
          );
        });
      const seenInRun = new Set<string>();
      for (const m of messages) {
        const tcs = (m as { role?: string; tool_calls?: { name?: string; arguments?: unknown }[] }).tool_calls;
        if (tcs) for (const tc of tcs) seenInRun.add(`${tc.name ?? ""}:${JSON.stringify(tc.arguments ?? {})}`);
      }
      const repeatedInRun = msg.tool_calls.some(
        (tc) => seenInRun.has(`${tc.name ?? ""}:${JSON.stringify(tc.arguments ?? {})}`)
      );
      const assistantContent = msg.content ?? "";
      messages.push({
        role: "assistant",
        content: assistantContent,
        tool_calls: msg.tool_calls,
      });
      if (deps.onPersistMessage) {
        const summary =
          msg.tool_calls?.length &&
          msg.tool_calls
            .map(
              (tc) =>
                `${tc.name ?? "?"}(${JSON.stringify(tc.arguments ?? {})})`
            )
            .join(", ");
        await deps.onPersistMessage(
          "assistant",
          summary ? `${assistantContent}\n[Tools: ${summary}]` : assistantContent,
          msg.tool_calls
        );
      }
      const endTurnToolName = deps.heartbeatEndTurnToolName ?? null;
      const endTurnSeen = endTurnToolName != null && msg.tool_calls.some((tc) => (tc.name ?? "") === endTurnToolName);
      if (endTurnSeen) {
        debug("run_loop", { event: "done", turn: turns, stopWhen: "tool", toolName: endTurnToolName });
        if (deps.onPersistMessage) {
          await deps.onPersistMessage("assistant", assistantContent);
          /** Persist HEARTBEAT_OK so the heartbeat scheduler treats this run as complete and does not skip the next tick. */
          await deps.onPersistMessage("assistant", HEARTBEAT_OK);
        }
        return { done: true, finalContent: assistantContent || "Heartbeat turn complete." };
      }
      if (sameAsPrev || repeatedInRun) {
        messages.push({ role: "system", content: RUN_LOOP_REPEATED_TOOL_CALL_MESSAGE });
        if (deps.onPersistMessage) {
          await deps.onPersistMessage("user", RUN_LOOP_REPEATED_TOOL_CALL_MESSAGE);
        }
      }
      const toolCallCountByName = new Map<string, number>();
      for (let i = 0; i < messages.length - 1; i++) {
        const tcs = (messages[i] as { tool_calls?: { name?: string }[] }).tool_calls;
        if (tcs) for (const t of tcs) {
          const n = t.name ?? "";
          toolCallCountByName.set(n, (toolCallCountByName.get(n) ?? 0) + 1);
        }
      }
      let executedAnyToolThisTurn = false;
      for (const tc of msg.tool_calls) {
        const name = tc.name ?? "";
        if (endTurnToolName != null && name === endTurnToolName) continue;
        const countSoFar = toolCallCountByName.get(name) ?? 0;
        if (countSoFar >= MAX_SAME_TOOL_CALLS_PER_RUN) {
          const capMessage = `You have already used the ${name} tool ${MAX_SAME_TOOL_CALLS_PER_RUN} times. Reply to the user now with what you have. Do not call ${name} again.`;
          messages.push({ role: "system", content: capMessage });
          if (deps.onPersistMessage) await deps.onPersistMessage("user", capMessage);
          debug("run_loop", { event: "tool_cap", toolName: name, count: countSoFar });
          break;
        }
        toolCallCountByName.set(name, countSoFar + 1);
        const args = (typeof tc.arguments === "object" && tc.arguments !== null)
          ? (tc.arguments as Record<string, unknown>)
          : {};
        if (name == null || name === "") {
          const rawPreview = truncateForLog(JSON.stringify(tc), 300);
          debug("run_loop", {
            event: "tool_call_skipped",
            reason: "missing_name",
            rawPreview,
          });
          messages.push({
            role: "system",
            content: formatToolCallMissingNameError(rawPreview),
          });
          continue;
        }
        debug("run_loop", { event: "tool_call", name, argsPreview: truncateForLog(JSON.stringify(args), 150) });
        const result: ToolCallResult = await deps.toolExecutor(name, args);
        executedAnyToolThisTurn = true;
        const resultContent = result.isError
          ? `[tool error] ${result.content}`
          : result.content;
        /** Tool output is from the system (environment), not the user; only real chat is user. */
        messages.push({ role: "system", content: resultContent });
        if (deps.toolResultSuccessSuffix != null && !result.isError) {
          messages.push({ role: "system", content: deps.toolResultSuccessSuffix });
        }
        if (deps.onPersistMessage) {
          const persistedContent =
            deps.toolResultSuccessSuffix != null && !result.isError
              ? `${resultContent}\n\n${deps.toolResultSuccessSuffix}`
              : resultContent;
          await deps.onPersistMessage("user", persistedContent);
        }
        if (result.isError) {
          messages.push({ role: "system", content: RUN_LOOP_TOOL_ERROR_FOLLOWUP });
          if (deps.onPersistMessage) {
            await deps.onPersistMessage("user", RUN_LOOP_TOOL_ERROR_FOLLOWUP);
          }
        }
      }
      if (deps.requireReplyPhaseAfterTools && executedAnyToolThisTurn && !replyPhaseScheduled) {
        replyPhaseScheduled = true;
        toolsOverride = [];
        messages.push({ role: "system", content: RUN_LOOP_REPLY_PHASE_MESSAGE });
        if (deps.onPersistMessage) {
          await deps.onPersistMessage("user", RUN_LOOP_REPLY_PHASE_MESSAGE);
        }
      }
      continue;
    }

    const finalContent = msg.content ?? "";
    // #region agent log
    fetch("http://127.0.0.1:7245/ingest/13540c59-9d40-405a-a4df-e70acbf0e8f0", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e87760" },
      body: JSON.stringify({
        sessionId: "e87760",
        location: "run-loop.ts:return-finalContent",
        message: "Returning finalContent (no tool_calls path)",
        data: {
          turn: turns,
          finalContentLength: finalContent.length,
          finalContentPreview: finalContent.slice(0, 400),
        },
        timestamp: Date.now(),
        hypothesisId: "H1",
      }),
    }).catch(() => {});
    // #endregion
    debug("run_loop", { event: "done", turn: turns, contentLength: finalContent.length });
    if (deps.onPersistMessage) {
      await deps.onPersistMessage("assistant", finalContent);
      /** In heartbeat mode, mark run complete so the scheduler does not skip the next tick (whether model used the tool or ended with content). */
      if (deps.heartbeatEndTurnToolName) {
        await deps.onPersistMessage("assistant", HEARTBEAT_OK);
      }
    }
    return {
      done: true,
      finalContent,
    };
  }

  debug("run_loop", { event: "max_turns", turns: maxTurns });
  return {
    done: true,
    finalContent: "[Run loop hit max turns]",
  };
}
