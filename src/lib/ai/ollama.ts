import type { AIProvider, AIResponse, Message, ToolCall, ToolDefinition } from "./types";
import type { HttpClient } from "../context";

export class OllamaProvider implements AIProvider {
  private model: string;
  private baseUrl: string;
  private http: HttpClient;

  constructor(model: string, baseUrl: string, http: HttpClient) {
    // strip "ollama/" prefix
    this.model = model.replace(/^ollama\//, "");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.http = http;
  }

  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    onToken: (token: string) => void
  ): Promise<AIResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role,
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
    }

    const resp = await this.http.fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
