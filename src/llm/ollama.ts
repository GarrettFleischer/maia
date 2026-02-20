/**
 * @fileoverview Ollama API client: /api/chat with tools support.
 * @module llm/ollama
 */

import { debug, truncateForLog } from "@/lib/logger";

export type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
  tool_calls?: { name: string; arguments: Record<string, unknown> }[];
};

export type OllamaTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type OllamaChatOptions = {
  baseUrl: string;
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  /** When set, enables thinking/reasoning for compatible models (e.g. deepseek-r1, qwen3, gpt-oss). */
  think?: boolean | "low" | "medium" | "high";
  /** When set, max context length in tokens (Ollama options.num_ctx). Overrides model default. */
  num_ctx?: number;
};

export type OllamaChatResponse = {
  message: {
    role: string;
    content: string;
    tool_calls?: { name: string; arguments: Record<string, unknown> }[];
  };
  done: boolean;
};

/**
 * Normalizes tool_calls from API response to a single shape.
 * Accepts both Ollama-style { name, arguments } and OpenAI-style { function: { name, arguments } }.
 * Drops entries with no name and logs when that happens.
 * @param raw - Raw tool_calls array from the API (or undefined).
 * @returns Normalized array of { name, arguments }.
 */
function normalizeToolCalls(raw: unknown): { name: string; arguments: Record<string, unknown> }[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: { name: string; arguments: Record<string, unknown> }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    let name: string | undefined;
    let args: Record<string, unknown> = {};
    if (typeof obj.function === "object" && obj.function !== null) {
      const fn = obj.function as Record<string, unknown>;
      name = typeof fn.name === "string" ? fn.name : undefined;
      args =
        typeof fn.arguments === "object" && fn.arguments !== null && !Array.isArray(fn.arguments)
          ? (fn.arguments as Record<string, unknown>)
          : typeof fn.arguments === "string"
            ? (() => {
                try {
                  return (JSON.parse(fn.arguments) as Record<string, unknown>) ?? {};
                } catch {
                  return {};
                }
              })()
            : {};
    } else {
      name = typeof obj.name === "string" ? obj.name : undefined;
      args =
        typeof obj.arguments === "object" && obj.arguments !== null && !Array.isArray(obj.arguments)
          ? (obj.arguments as Record<string, unknown>)
          : {};
    }
    if (name != null && name !== "") {
      out.push({ name, arguments: args });
    } else {
      debug("llm", {
        event: "tool_call_dropped",
        reason: "missing_name",
        index: i,
        rawPreview: truncateForLog(JSON.stringify(item), 200),
      });
    }
  }
  return out;
}

/**
 * Calls Ollama /api/chat (non-streaming). Injects tools if provided.
 */
export async function ollamaChat(
  options: OllamaChatOptions,
  fetchFn: typeof fetch = fetch
): Promise<OllamaChatResponse> {
  const url = `${options.baseUrl.replace(/\/$/, "")}/api/chat`;
  const body = {
    model: options.model,
    messages: options.messages,
    stream: false,
    ...(options.think !== undefined ? { think: options.think } : {}),
    ...(options.num_ctx !== undefined && options.num_ctx > 0 ? { options: { num_ctx: options.num_ctx } } : {}),
    ...(options.tools && options.tools.length > 0
      ? {
          tools: options.tools.map((t) => ({
            type: "function",
            function: {
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters,
            },
          })),
        }
      : {}),
  };
  debug("llm", {
    event: "request",
    model: options.model,
    messageCount: options.messages.length,
    hasTools: (options.tools?.length ?? 0) > 0,
    lastMessagePreview: options.messages.length > 0
      ? truncateForLog(JSON.stringify(options.messages[options.messages.length - 1]))
      : undefined,
  });
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }
  const data = (await res.json()) as OllamaChatResponse;
  if (data.message?.tool_calls != null) {
    data.message.tool_calls = normalizeToolCalls(data.message.tool_calls);
  }
  debug("llm", {
    event: "response",
    model: options.model,
    done: data.done,
    contentLength: data.message?.content?.length ?? 0,
    contentPreview: data.message?.content ? truncateForLog(data.message.content) : undefined,
    toolCallCount: data.message?.tool_calls?.length ?? 0,
  });
  return data;
}

/** Chunk yielded by ollamaChatStream: either a content delta or the final message. */
export type OllamaStreamChunk =
  | { delta: string }
  | { done: true; message: { role: string; content: string; tool_calls?: { name: string; arguments: Record<string, unknown> }[] } };

/**
 * Calls Ollama /api/chat with stream: true; yields content deltas and final message.
 * Supports: (1) Ollama NDJSON with message.content and done;
 * (2) SSE-style lines with "data: " prefix; (3) OpenAI-style choices[0].delta.content and finish_reason.
 * @param options - Same as ollamaChat (baseUrl, model, messages, optional tools).
 * @param fetchFn - Fetch implementation (for tests or Node).
 * @yields { delta: string } for each content chunk, then { done: true, message } on completion.
 */
export async function* ollamaChatStream(
  options: OllamaChatOptions,
  fetchFn: typeof fetch = fetch
): AsyncGenerator<OllamaStreamChunk> {
  const url = `${options.baseUrl.replace(/\/$/, "")}/api/chat`;
  const body = {
    model: options.model,
    messages: options.messages,
    stream: true,
    ...(options.think !== undefined ? { think: options.think } : {}),
    ...(options.num_ctx !== undefined && options.num_ctx > 0 ? { options: { num_ctx: options.num_ctx } } : {}),
    ...(options.tools && options.tools.length > 0
      ? {
          tools: options.tools.map((t) => ({
            type: "function",
            function: {
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters,
            },
          })),
        }
      : {}),
  };
  debug("llm", {
    event: "stream_request",
    model: options.model,
    messageCount: options.messages.length,
    hasTools: (options.tools?.length ?? 0) > 0,
  });
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Ollama stream: no body");
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let lastMessage: { role: string; content: string; tool_calls?: { name: string; arguments: Record<string, unknown> }[] } = {
    role: "assistant",
    content: "",
  };
  let yieldedFinal = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("data:")) {
          trimmed = trimmed.slice(5).trim();
          if (trimmed === "" || trimmed === "[DONE]") continue;
        }
        try {
          const data = JSON.parse(trimmed) as {
            message?: { role?: string; content?: string; tool_calls?: { name: string; arguments: Record<string, unknown> }[] };
            done?: boolean;
            choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
            content?: string;
          };
          const topLevelContent = typeof data.content === "string" ? data.content : "";
          if (topLevelContent.length > 0) {
            fullContent += topLevelContent;
            lastMessage = { ...lastMessage, content: fullContent };
            yield { delta: topLevelContent };
          }
          const choice = data.choices?.[0];
          const openAiDone = choice?.finish_reason != null && choice.finish_reason !== "";
          const openAiContent = typeof choice?.delta?.content === "string" ? choice.delta.content : "";

          if (choice !== undefined && (openAiContent.length > 0 || openAiDone)) {
            if (openAiContent.length > 0) {
              fullContent += openAiContent;
              lastMessage = { role: "assistant", content: fullContent };
              yield { delta: openAiContent };
            }
            if (openAiDone) {
              lastMessage.content = fullContent;
              debug("llm", {
                event: "stream_response",
                model: options.model,
                contentLength: fullContent.length,
                contentPreview: truncateForLog(fullContent),
                toolCallCount: lastMessage.tool_calls?.length ?? 0,
              });
              yieldedFinal = true;
              yield { done: true, message: lastMessage };
              return;
            }
          } else {
            const msg = data.message;
            if (msg && typeof msg.content === "string") {
              fullContent += msg.content;
              lastMessage = {
                role: msg.role ?? "assistant",
                content: fullContent,
                tool_calls: msg.tool_calls != null ? normalizeToolCalls(msg.tool_calls) : undefined,
              };
              if (msg.content.length > 0) yield { delta: msg.content };
            }
            if (data.done === true) {
              if (msg) {
                lastMessage.role = msg.role ?? lastMessage.role;
                if (fullContent.length === 0 && typeof msg.content === "string" && msg.content.length > 0) {
                  fullContent = msg.content;
                }
                lastMessage.content = fullContent;
                if (msg.tool_calls) lastMessage.tool_calls = normalizeToolCalls(msg.tool_calls);
              } else {
                lastMessage.content = fullContent;
              }
              debug("llm", {
                event: "stream_response",
                model: options.model,
                contentLength: fullContent.length,
                contentPreview: truncateForLog(fullContent),
                toolCallCount: lastMessage.tool_calls?.length ?? 0,
              });
              yieldedFinal = true;
              yield { done: true, message: lastMessage };
              return;
            }
          }
        } catch {
          // skip malformed line
        }
      }
    }
    if (!yieldedFinal && (fullContent.length > 0 || lastMessage.content.length > 0)) {
      lastMessage.content = fullContent.length > 0 ? fullContent : lastMessage.content;
      debug("llm", {
        event: "stream_response",
        model: options.model,
        contentLength: lastMessage.content.length,
        contentPreview: truncateForLog(lastMessage.content),
        toolCallCount: lastMessage.tool_calls?.length ?? 0,
      });
      yield { done: true, message: lastMessage };
    }
  } finally {
    reader.releaseLock();
  }
}
