import type { AIProvider, AIResponse, Message, ToolCall, ToolDefinition } from "./types";
import type { HttpClient } from "../context";
import type { ReasoningEffort } from "../types";

export class OpenRouterProvider implements AIProvider {
  private model: string;
  private apiKey: string;
  private http: HttpClient;
  private reasoningEffort: ReasoningEffort;

  constructor(
    model: string,
    apiKey: string,
    http: HttpClient,
    reasoningEffort: ReasoningEffort = "medium",
  ) {
    // strip "openrouter/" prefix
    this.model = model.replace(/^openrouter\//, "");
    this.apiKey = apiKey;
    this.http = http;
    this.reasoningEffort = reasoningEffort;
  }

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

    if (this.reasoningEffort !== "off") {
      body.reasoning = { effort: this.reasoningEffort };
    }

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

    const resp = await this.http.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: options?.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Maia Agent System",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenRouter error ${resp.status}: ${text}`);
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
        if (data === "[DONE]") { stopped = true; continue; }

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

        // accumulate streaming tool calls
        const toolCallDeltas = delta.tool_calls as
          | Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
          | undefined;

        if (toolCallDeltas) {
          for (const tc of toolCallDeltas) {
            if (!toolCallMap.has(tc.index)) {
              toolCallMap.set(tc.index, { id: tc.id ?? crypto.randomUUID(), name: "", argsRaw: "" });
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
      try { args = JSON.parse(tc.argsRaw); } catch { /* ignore */ }
      toolCalls.push({ id: tc.id, name: tc.name, args });
    }

    return { content: fullContent, toolCalls, stopped };
  }
}
