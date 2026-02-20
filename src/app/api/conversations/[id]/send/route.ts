/**
 * @fileoverview Send a user message, run the agent, persist and return the reply.
 * @module app/api/conversations/[id]/send/route
 *
 * POST /api/conversations/[id]/send — body: { content }. Appends user message, runs agent, returns NDJSON:
 * when MAIA_LLM_STREAMING is enabled: {"delta":"..."} lines then {"done":true,"content":"..."};
 * when disabled (default): single {"done":true,"content":"..."} after full response (including thinking/tool calls).
 * Persists assistant message, 200.
 */

import { runAgent } from "@/agent/runner";
import { createAgentRepository } from "@/db/agents";
import { createConversationRepository } from "@/db/conversations";
import { createMessageRepository } from "@/db/messages";
import { createMemoryRepository } from "@/db/memory";
import { createSecurityViolationsRepository } from "@/db/security-violations";
import { createTimerRepository } from "@/db/timers";
import { openDb } from "@/db/client";
import { loadAgentMdContext } from "@/heartbeat/runner";
import { requireApiKey } from "@/lib/auth";
import { broadcast } from "@/lib/conversation-events";
import { parseOllamaNumCtx, parseOllamaThink } from "@/lib/ollama-env";
import { isStreamingEnabled } from "@/lib/streaming-env";
import { createContainer } from "@/lib/container";
import type { OllamaMessage } from "@/llm/ollama";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

const encoder = new TextEncoder();

function ndjsonLine(obj: { delta?: string; done?: boolean; content?: string; error?: string }): Uint8Array {
  return encoder.encode(JSON.stringify(obj) + "\n");
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  const { id: conversationId } = await context.params;
  let body: { content?: string };
  try {
    body = (await request.json()) as { content?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }

  const container = createContainer();
  const db = await openDb(container.dbPath);
  const convRepo = createConversationRepository(db);
  const msgRepo = createMessageRepository(db);
  const conv = await convRepo.get(conversationId);
  if (!conv) {
    db.close();
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (conv.type !== "user_chat") {
    db.close();
    return NextResponse.json(
      { error: "Sending is only allowed in user chats" },
      { status: 403 }
    );
  }

  const userMsgId = randomUUID();
  await msgRepo.append(conversationId, { type: "user", role: "user", content }, userMsgId);
  broadcast(conversationId);

  const agentRepo = createAgentRepository(db, container.sandboxRoot, {
    mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
  });
  const agent = await agentRepo.get(conv.agent_id);
  if (!agent) {
    db.close();
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const existing = await msgRepo.listByConversation(conversationId);
  const ollamaMessages: OllamaMessage[] = existing
    .filter((m) => m.type === "user" || m.type === "assistant")
    .map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content ?? "",
    }));

  const mdContext = loadAgentMdContext(container.sandboxRoot, conv.agent_id);
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const defaultModel = process.env.OLLAMA_DEFAULT_MODEL ?? "llama3";
  const securityGateModel = process.env.OLLAMA_SECURITY_GATE_MODEL ?? "llama3";
  const ollamaThink = parseOllamaThink();
  const ollamaNumCtx = parseOllamaNumCtx();

  const timerRepo = createTimerRepository(db);
  const memoryRepo = createMemoryRepository(db);

  const streaming = isStreamingEnabled();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const outcome = await runAgent({
          agentId: conv.agent_id,
          sandboxRoot: container.sandboxRoot,
          model: agent.model ?? defaultModel,
          defaultModel,
          ollamaBaseUrl: baseUrl,
          securityGateModel,
          think: ollamaThink,
          num_ctx: ollamaNumCtx,
          mdContext,
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
          requireReplyPhaseAfterTools: true,
          ...(streaming ? { onChunk: (chunk: string) => controller.enqueue(ndjsonLine({ delta: chunk })) } : {}),
        });

        if (!outcome.ok) {
          if ("blocked" in outcome && outcome.blocked) {
            const violationsRepo = createSecurityViolationsRepository(db);
            await violationsRepo.insert(conv.agent_id, outcome.reason);
            const count = await violationsRepo.countByAgent(conv.agent_id);
            if (count >= 3) {
              await agentRepo.update(conv.agent_id, { enabled: 0 });
            }
          }
          const errContent =
            "blocked" in outcome && outcome.blocked
              ? `[Blocked: ${outcome.reason}]`
              : `[Error: ${"error" in outcome ? outcome.error : "Unknown"}]`;
          const assistantId = randomUUID();
          await msgRepo.append(conversationId, { type: "assistant", role: "assistant", content: errContent }, assistantId);
          broadcast(conversationId);
          controller.enqueue(ndjsonLine({ done: true, content: errContent }));
        } else {
          const displayContent =
            outcome.finalContent?.trim() ||
            "I've completed your request. Let me know if you need anything else.";
          // #region agent log
          fetch("http://127.0.0.1:7245/ingest/13540c59-9d40-405a-a4df-e70acbf0e8f0", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "e87760" },
            body: JSON.stringify({
              sessionId: "e87760",
              location: "send/route.ts:displayContent",
              message: "Display content being persisted",
              data: {
                displayContentLength: displayContent.length,
                displayContentPreview: displayContent.slice(0, 400),
              },
              timestamp: Date.now(),
              hypothesisId: "H1",
            }),
          }).catch(() => {});
          // #endregion
          const assistantId = randomUUID();
          await msgRepo.append(conversationId, { type: "assistant", role: "assistant", content: displayContent }, assistantId);
          broadcast(conversationId);
          controller.enqueue(ndjsonLine({ done: true, content: displayContent }));
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        controller.enqueue(ndjsonLine({ done: true, error: errMsg }));
      } finally {
        db.close();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
