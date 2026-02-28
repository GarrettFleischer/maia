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

export class OpenRouterProvider implements AIProvider {
  private model: string;
  private apiKey: string;
  private http: HttpClient;
  private reasoningEffort: ReasoningEffort;
  private modelParams: ModelGenerationParams | undefined;

  constructor(
    model: string,
    apiKey: string,
    http: HttpClient,
    reasoningEffort: ReasoningEffort = "medium",
    modelParams?: ModelGenerationParams,
  ) {
    // strip "openrouter/" prefix; free router needs full "openrouter/free" in API
    const stripped = model.replace(/^openrouter\//, "");
    this.model = stripped === "free" ? "openrouter/free" : stripped;
    this.apiKey = apiKey;
    this.http = http;
    this.reasoningEffort = reasoningEffort;
    this.modelParams = modelParams;
  }

  async *stream(
    messages: Message[],
    tools: ToolDefinition[],
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    const body = this.buildBody(messages, tools);
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
    const toolCallMap = new Map<number, { id: string; name: string; argsRaw: string }>();

    for await (const event of this.readOpenRouterStream(reader, decoder, toolCallMap)) {
      yield event;
    }

    for (const [, tc] of Array.from(toolCallMap.entries()).sort((a, b) => a[0] - b[0])) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.argsRaw);
      } catch {
        /* ignore */
      }
      yield { type: "tool_call", toolCall: { id: tc.id, name: tc.name, args } };
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
        role: m.role === "agent" ? "assistant" : m.role,
        content: m.content,
      })),
      stream: true,
    };
    if (this.reasoningEffort !== "off") {
      body.reasoning = { effort: this.reasoningEffort };
    }
    if (this.modelParams) {
      if (this.modelParams.temperature !== undefined) body.temperature = this.modelParams.temperature;
      if (this.modelParams.top_p !== undefined) body.top_p = this.modelParams.top_p;
      if (this.modelParams.top_k !== undefined) body.top_k = this.modelParams.top_k;
      if (this.modelParams.min_p !== undefined) body.min_p = this.modelParams.min_p;
      if (this.modelParams.presence_penalty !== undefined) body.presence_penalty = this.modelParams.presence_penalty;
      if (this.modelParams.repetition_penalty !== undefined) body.repetition_penalty = this.modelParams.repetition_penalty;
      if (this.modelParams.options && Object.keys(this.modelParams.options).length > 0) {
        Object.assign(body, this.modelParams.options);
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
      body.tool_choice = "auto";
    }
    return body;
  }

  private async *readOpenRouterStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    toolCallMap: Map<number, { id: string; name: string; argsRaw: string }>,
  ): AsyncGenerator<StreamEvent> {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

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
          yield { type: "text_delta", delta: delta.content };
        }

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
  }
}
