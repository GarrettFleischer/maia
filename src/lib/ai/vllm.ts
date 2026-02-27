/**
 * @fileoverview vLLM AI provider — OpenAI-compatible chat completions over configurable base URL.
 * @module lib/ai/vllm
 */

import type { AIProvider, AIResponse, Message, ToolCall, ToolDefinition } from "./types";
import type { HttpClient } from "../context";

/**
 * vLLM provider for OpenAI-compatible servers (e.g. vllm serve).
 * Uses /v1/chat/completions with SSE streaming; no API key by default.
 *
 * @brief Provider that calls a vLLM server's OpenAI-compatible chat completions endpoint.
 */
export class VllmProvider implements AIProvider {
  private model: string;
  private baseUrl: string;
  private http: HttpClient;

  /**
   * @param model - Model identifier; "vllm/" prefix is stripped before sending.
   * @param baseUrl - Server base URL (e.g. http://localhost:8000/v1).
   * @param http - HTTP client for requests.
   */
  constructor(model: string, baseUrl: string, http: HttpClient) {
    this.model = model.replace(/^vllm\//, "");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.http = http;
  }

  /**
   * @brief Stream a completion from the vLLM server and return content and tool calls.
   * @param messages - Chat messages (role "agent" is sent as "assistant").
   * @param tools - Optional tool definitions for function calling.
   * @param onToken - Callback for each streamed content token.
   * @returns Final content, tool calls, and stopped flag.
   */
  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    onToken: (token: string) => void,
    options?: import("./types").CompleteOptions,
  ): Promise<AIResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role === "agent" ? "assistant" : m.role,
        content: m.content,
      })),
      stream: true,
    };

    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = "auto";
    }

    const url = `${this.baseUrl}/chat/completions`;
    const resp = await this.http.fetch(url, {
      method: "POST",
      signal: options?.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`vLLM error ${resp.status}: ${text}`);
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    const toolCallMap = new Map<number, { id: string; name: string; argsRaw: string }>();
    let stopped = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          stopped = true;
          continue;
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
        if (!choices?.length) continue;
        const delta = choices[0].delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        if (typeof delta.content === "string" && delta.content) {
          fullContent += delta.content;
          onToken(delta.content);
        }

        const toolCallDeltas = delta.tool_calls as
          | Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
          | undefined;

        if (toolCallDeltas) {
          for (const tc of toolCallDeltas) {
            if (!toolCallMap.has(tc.index)) {
              toolCallMap.set(tc.index, {
                id: tc.id ?? crypto.randomUUID(),
                name: "",
                argsRaw: "",
              });
            }
            const entry = toolCallMap.get(tc.index)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.argsRaw += tc.function.arguments;
          }
        }
      }
    }

    const toolCalls: ToolCall[] = [];
    for (const [, tc] of toolCallMap) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.argsRaw);
      } catch {
        /* ignore */
      }
      toolCalls.push({ id: tc.id, name: tc.name, args });
    }

    return { content: fullContent, toolCalls, stopped };
  }
}
