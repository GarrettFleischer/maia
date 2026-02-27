/**
 * @fileoverview Ollama AI provider for local Ollama or Ollama Cloud. Supports optional API key for Cloud
 * and optional reasoning effort (maps to Ollama think parameter).
 * @module lib/ai/ollama
 */
import type { AIProvider, AIResponse, CompleteOptions, Message, ToolCall, ToolDefinition } from "./types";
import type { HttpClient } from "../context";
import type { ReasoningEffort } from "../types";

export class OllamaProvider implements AIProvider {
  private model: string;
  private baseUrl: string;
  private http: HttpClient;
  private apiKey: string | undefined;
  private reasoningEffort: ReasoningEffort;

  /**
   * @param model - Model id with optional "ollama/" prefix (stripped before request).
   * @param baseUrl - Ollama server URL (e.g. http://localhost:11434 or https://ollama.com for Cloud).
   * @param http - HTTP client.
   * @param apiKey - Optional API key for Ollama Cloud; when set, sent as Authorization: Bearer.
   * @param reasoningEffort - Reasoning effort (off/low/medium/high); applied as think param when model supports it.
   */
  constructor(
    model: string,
    baseUrl: string,
    http: HttpClient,
    apiKey?: string,
    reasoningEffort: ReasoningEffort = "medium",
  ) {
    // strip "ollama/" prefix
    this.model = model.replace(/^ollama\//, "");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.http = http;
    this.apiKey = apiKey;
    this.reasoningEffort = reasoningEffort;
  }

  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    onToken: (token: string) => void,
    options?: CompleteOptions,
  ): Promise<AIResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
    };

    if (this.reasoningEffort === "off") {
      body.think = false;
    } else {
      const isGptOss = this.model.startsWith("gpt-oss");
      if (isGptOss) {
        body.think = this.reasoningEffort;
      } else {
        body.think = true;
      }
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
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    const resp = await this.http.fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Ollama error ${resp.status}: ${text}`);
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    const toolCalls: ToolCall[] = [];
    let stopped = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter(Boolean);

      for (const line of lines) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const msg = parsed.message as Record<string, unknown> | undefined;
        if (msg?.content) {
          const token = msg.content as string;
          fullContent += token;
          onToken(token);
        }

        // Tool calls from Ollama
        if (msg?.tool_calls) {
          const calls = msg.tool_calls as Array<{
            function: { name: string; arguments: Record<string, unknown> };
          }>;
          for (const call of calls) {
            toolCalls.push({
              id: crypto.randomUUID(),
              name: call.function.name,
              args: call.function.arguments,
            });
          }
        }

        if (parsed.done) {
          stopped = true;
        }
      }
    }

    return { content: fullContent, toolCalls, stopped };
  }
}
