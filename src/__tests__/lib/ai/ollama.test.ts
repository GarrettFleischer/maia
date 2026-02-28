/**
 * @fileoverview Tests for Ollama AI provider (streaming, tool calls, errors).
 * @module __tests__/lib/ai/ollama.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext, FakeHttp } from "../../helpers/fakes";
import type { HttpResponse } from "@/lib/context";
import { OllamaProvider } from "@/lib/ai/ollama";

/** Build a streaming response body from newline-delimited JSON lines. */
function streamBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
}

function streamResponse(status: number, lines: string[]): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: streamBody(lines),
    async text() {
      return lines.join("\n");
    },
    async json() {
      return JSON.parse(lines[0] ?? "{}");
    },
  };
}

describe("OllamaProvider", () => {
  let ctx: ReturnType<typeof makeTestContext>;
  let http: FakeHttp;

  beforeEach(() => {
    http = new FakeHttp();
    ctx = makeTestContext({ http });
  });

  it("sends POST to baseUrl/api/chat with correct body and stream: true", async () => {
    let capturedBody: unknown = null;
    http.on(/\/api\/chat/, async (_url, init) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return streamResponse(200, [
        JSON.stringify({ message: { content: "Hi" }, done: true }),
      ]);
    });

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http
    );
    await provider.complete(
      [{ role: "user", content: "Hello" }],
      [],
      () => {}
    );

    expect(capturedBody).toEqual({
      model: "llama3.2",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      think: true,
    });
  });

  it("includes tools in body when provided", async () => {
    let capturedBody: Record<string, unknown> = {};
    http.on(/\/api\/chat/, async (_url, init) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : {};
      return streamResponse(200, [
        JSON.stringify({ message: { content: "" }, done: true }),
      ]);
    });

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http
    );
    await provider.complete(
      [{ role: "user", content: "x" }],
      [
        {
          name: "my_tool",
          description: "Does something",
          parameters: { type: "object" },
        },
      ],
      () => {}
    );

    expect(capturedBody.tools).toBeDefined();
    expect(Array.isArray(capturedBody.tools)).toBe(true);
    expect((capturedBody.tools as unknown[])[0]).toMatchObject({
      type: "function",
      function: { name: "my_tool", description: "Does something" },
    });
  });

  it("parses streaming tokens and calls onToken", async () => {
    const tokens: string[] = [];
    http.on(/\/api\/chat/, async () =>
      streamResponse(200, [
        JSON.stringify({ message: { content: "Hello" }, done: false }),
        JSON.stringify({ message: { content: " " }, done: false }),
        JSON.stringify({ message: { content: "world" }, done: true }),
      ])
    );

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http
    );
    const result = await provider.complete(
      [{ role: "user", content: "Hi" }],
      [],
      (t) => tokens.push(t)
    );

    expect(tokens).toEqual(["Hello", " ", "world"]);
    expect(result.content).toBe("Hello world");
    expect(result.stopped).toBe(true);
  });

  it("stream() yields text_delta and stop events", async () => {
    http.on(/\/api\/chat/, async () =>
      streamResponse(200, [
        JSON.stringify({ message: { content: "Hi" }, done: false }),
        JSON.stringify({ message: { content: "!" }, done: true }),
      ])
    );

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http
    );
    const events: Array<{ type: string; delta?: string }> = [];
    for await (const e of provider.stream([{ role: "user", content: "x" }], [])) {
      events.push(e.type === "text_delta" ? { type: e.type, delta: e.delta } : { type: e.type });
    }
    expect(events).toEqual([
      { type: "text_delta", delta: "Hi" },
      { type: "text_delta", delta: "!" },
      { type: "stop" },
    ]);
  });

  it("stream() yields thinking_delta when message.thinking is present", async () => {
    http.on(/\/api\/chat/, async () =>
      streamResponse(200, [
        JSON.stringify({ message: { thinking: "Let me " }, done: false }),
        JSON.stringify({ message: { thinking: "consider." }, done: false }),
        JSON.stringify({ message: { content: "Done." }, done: true }),
      ])
    );

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http
    );
    const events: Array<{ type: string; delta?: string }> = [];
    for await (const e of provider.stream([{ role: "user", content: "x" }], [])) {
      if (e.type === "text_delta" || e.type === "thinking_delta") {
        events.push({ type: e.type, delta: e.delta });
      } else {
        events.push({ type: e.type });
      }
    }
    expect(events).toEqual([
      { type: "thinking_delta", delta: "Let me " },
      { type: "thinking_delta", delta: "consider." },
      { type: "text_delta", delta: "Done." },
      { type: "stop" },
    ]);
  });

  it("complete() calls onThinkingToken for thinking_delta and does not add to content", async () => {
    const tokens: string[] = [];
    const thinking: string[] = [];
    http.on(/\/api\/chat/, async () =>
      streamResponse(200, [
        JSON.stringify({ message: { thinking: "Reasoning " }, done: false }),
        JSON.stringify({ message: { thinking: "here." }, done: false }),
        JSON.stringify({ message: { content: "Answer." }, done: true }),
      ])
    );

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http
    );
    const result = await provider.complete(
      [{ role: "user", content: "Hi" }],
      [],
      (t) => tokens.push(t),
      { onThinkingToken: (d) => thinking.push(d) }
    );

    expect(thinking).toEqual(["Reasoning ", "here."]);
    expect(tokens).toEqual(["Answer."]);
    expect(result.content).toBe("Answer.");
  });

  it("accumulates tool calls from stream", async () => {
    http.on(/\/api\/chat/, async () =>
      streamResponse(200, [
        JSON.stringify({
          message: {
            content: "",
            tool_calls: [
              {
                function: { name: "foo", arguments: { x: 1 } },
              },
            ],
          },
          done: true,
        }),
      ])
    );

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http
    );
    const result = await provider.complete(
      [{ role: "user", content: "Use foo" }],
      [],
      () => {}
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("foo");
    expect(result.toolCalls[0].args).toEqual({ x: 1 });
  });

  it("throws on HTTP error with status and body", async () => {
    http.on(/\/api\/chat/, async () => ({
      ok: false,
      status: 500,
      body: null,
      async text() {
        return "Internal Server Error";
      },
      async json() {
        return {};
      },
    }));

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http
    );

    await expect(
      provider.complete([{ role: "user", content: "Hi" }], [], () => {})
    ).rejects.toThrow("Ollama error 500: Internal Server Error");
  });

  it("strips ollama/ prefix from model in request", async () => {
    let model = "";
    http.on(/\/api\/chat/, async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      model = body.model ?? "";
      return streamResponse(200, [
        JSON.stringify({ message: { content: "" }, done: true }),
      ]);
    });

    const provider = new OllamaProvider(
      "ollama/qwen2.5-coder",
      "http://localhost:11434",
      ctx.http
    );
    await provider.complete([{ role: "user", content: "x" }], [], () => {});

    expect(model).toBe("qwen2.5-coder");
  });

  it("sends Authorization Bearer header when apiKey is provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    http.on(/\/api\/chat/, async (_url, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return streamResponse(200, [
        JSON.stringify({ message: { content: "Hi" }, done: true }),
      ]);
    });

    const provider = new OllamaProvider(
      "ollama/minimax-m2:cloud",
      "https://ollama.com",
      ctx.http,
      "my-ollama-cloud-key"
    );
    await provider.complete([{ role: "user", content: "Hello" }], [], () => {});

    expect(capturedHeaders["Authorization"]).toBe("Bearer my-ollama-cloud-key");
  });

  it("does not send Authorization header when apiKey is omitted", async () => {
    let capturedHeaders: Record<string, string> = {};
    http.on(/\/api\/chat/, async (_url, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return streamResponse(200, [
        JSON.stringify({ message: { content: "Hi" }, done: true }),
      ]);
    });

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http
    );
    await provider.complete([{ role: "user", content: "Hello" }], [], () => {});

    expect(capturedHeaders["Authorization"]).toBeUndefined();
  });

  it("includes think: true for non-gpt-oss models when thinking level is set", async () => {
    let capturedBody: Record<string, unknown> = {};
    http.on(/\/api\/chat/, async (_url, init) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      return streamResponse(200, [
        JSON.stringify({ message: { content: "" }, done: true }),
      ]);
    });

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http,
      undefined,
      "medium"
    );
    await provider.complete([{ role: "user", content: "Hi" }], [], () => {});

    expect(capturedBody.think).toBe(true);
  });

  it("includes string think level for gpt-oss model", async () => {
    let capturedBody: Record<string, unknown> = {};
    http.on(/\/api\/chat/, async (_url, init) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      return streamResponse(200, [
        JSON.stringify({ message: { content: "" }, done: true }),
      ]);
    });

    const provider = new OllamaProvider(
      "ollama/gpt-oss",
      "http://localhost:11434",
      ctx.http,
      undefined,
      "high"
    );
    await provider.complete([{ role: "user", content: "Hi" }], [], () => {});

    expect(capturedBody.think).toBe("high");
  });

  it("sends think: false when reasoning effort is off", async () => {
    let capturedBody: Record<string, unknown> = {};
    http.on(/\/api\/chat/, async (_url, init) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      return streamResponse(200, [
        JSON.stringify({ message: { content: "" }, done: true }),
      ]);
    });

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http,
      undefined,
      "off"
    );
    await provider.complete([{ role: "user", content: "Hi" }], [], () => {});

    expect(capturedBody.think).toBe(false);
  });

  it("includes options from modelParams when provided", async () => {
    let capturedBody: Record<string, unknown> = {};
    http.on(/\/api\/chat/, async (_url, init) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      return streamResponse(200, [
        JSON.stringify({ message: { content: "" }, done: true }),
      ]);
    });

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http,
      undefined,
      "medium",
      { temperature: 0.6, top_p: 0.95, top_k: 20 }
    );
    await provider.complete([{ role: "user", content: "Hi" }], [], () => {});

    expect(capturedBody.options).toEqual({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
    });
  });

  it("merges modelParams.options into body.options", async () => {
    let capturedBody: Record<string, unknown> = {};
    http.on(/\/api\/chat/, async (_url, init) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      return streamResponse(200, [
        JSON.stringify({ message: { content: "" }, done: true }),
      ]);
    });

    const provider = new OllamaProvider(
      "ollama/llama3.2",
      "http://localhost:11434",
      ctx.http,
      undefined,
      "medium",
      { temperature: 0.6, options: { num_ctx: 16384 } }
    );
    await provider.complete([{ role: "user", content: "Hi" }], [], () => {});

    expect(capturedBody.options).toMatchObject({ temperature: 0.6, num_ctx: 16384 });
  });
});
