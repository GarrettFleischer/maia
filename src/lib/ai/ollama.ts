/**
 * @fileoverview Ollama AI provider for local Ollama or Ollama Cloud. Supports optional API key for Cloud
 * and optional reasoning effort (maps to Ollama think parameter).
 * @module lib/ai/ollama
 */
import type {
  AIProvider,
  AIResponse,
  CompleteOptions,
  Message,
  StreamEvent,
  StreamOptions,
  ToolCall,
  ToolDefinition,
} from "./types";
import type { HttpClient } from "../context";
import type { ModelGenerationParams, ReasoningEffort } from "../types";

export class OllamaProvider implements AIProvider {
  private model: string;
  private baseUrl: string;
  private http: HttpClient;
  private apiKey: string | undefined;
  private reasoningEffort: ReasoningEffort;
  private modelParams: ModelGenerationParams | undefined;

  /**
   * @param model - Model id with optional "ollama/" prefix (stripped before request).
   * @param baseUrl - Ollama server URL (e.g. http://localhost:11434 or https://ollama.com for Cloud).
   * @param http - HTTP client.
   * @param apiKey - Optional API key for Ollama Cloud; when set, sent as Authorization: Bearer.
   * @param reasoningEffort - Reasoning effort (off/low/medium/high); applied as think param when model supports it.
   * @param modelParams - Optional per-model generation params (temperature, top_p, etc.); sent as body.options.
   */
  constructor(
    model: string,
    baseUrl: string,
    http: HttpClient,
    apiKey?: string,
    reasoningEffort: ReasoningEffort = "medium",
    modelParams?: ModelGenerationParams,
  ) {
    // strip "ollama/" prefix
    this.model = model.replace(/^ollama\//, "");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.http = http;
    this.apiKey = apiKey;
    this.reasoningEffort = reasoningEffort;
    this.modelParams = modelParams;
  }

  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    const body = this.buildBody(messages, tools);
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

    for await (const event of this.readOllamaStream(reader, decoder)) {
      yield event;
    }
    yield { type: "stop" };
  }

  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    onToken: (token: string) => void,
    options?: CompleteOptions,
  ): Promise<AIResponse> {
    let content = "";
    const toolCalls: ToolCall[] = [];
    let stopped = false;
    for await (const event of this.stream(messages, tools, { signal: options?.signal })) {
      if (event.type === "text_delta") {
        content += event.delta;
        onToken(event.delta);
      } else if (event.type === "thinking_delta") {
        options?.onThinkingToken?.(event.delta);
      } else if (event.type === "tool_call") {
        toolCalls.push(event.toolCall);
      } else if (event.type === "stop") {
        stopped = true;
      }
    }
    return { content, toolCalls, stopped };
  }

  private buildBody(messages: Message[], tools: ToolDefinition[]): Record<string, unknown> {
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
    if (this.modelParams) {
      const opts: Record<string, unknown> = { ...this.modelParams.options };
      if (this.modelParams.temperature !== undefined) opts.temperature = this.modelParams.temperature;
      if (this.modelParams.top_p !== undefined) opts.top_p = this.modelParams.top_p;
      if (this.modelParams.top_k !== undefined) opts.top_k = this.modelParams.top_k;
      if (this.modelParams.min_p !== undefined) opts.min_p = this.modelParams.min_p;
      if (this.modelParams.repetition_penalty !== undefined) opts.repeat_penalty = this.modelParams.repetition_penalty;
      if (this.modelParams.presence_penalty !== undefined) opts.presence_penalty = this.modelParams.presence_penalty;
      if (Object.keys(opts).length > 0) body.options = opts;
    }
    return body;
  }

  private async *readOllamaStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
  ): AsyncGenerator<StreamEvent> {
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
        if (msg?.thinking !== undefined && msg.thinking !== null) {
          yield { type: "thinking_delta", delta: String(msg.thinking) };
        }
        if (msg?.content) {
          const token = msg.content as string;
          yield { type: "text_delta", delta: token };
        }
        if (msg?.tool_calls) {
          const calls = msg.tool_calls as Array<{
            function: { name: string; arguments: Record<string, unknown> };
          }>;
          for (const call of calls) {
            yield {
              type: "tool_call",
              toolCall: {
                id: crypto.randomUUID(),
                name: call.function.name,
                args: call.function.arguments,
              },
            };
          }
        }
      }
    }
  }
}
