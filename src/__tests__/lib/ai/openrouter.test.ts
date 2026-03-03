/**
 * @fileoverview Tests for OpenRouter AI provider (SSE streaming, tool calls, auth).
 * @module __tests__/lib/ai/openrouter.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext, FakeHttp } from "../../helpers/fakes";
import type { HttpResponse } from "@/lib/context";
import { OpenRouterProvider } from "@/lib/ai/openrouter";

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
      return {};
    },
  };
}

describe("OpenRouterProvider", () => {
  let ctx: ReturnType<typeof makeTestContext>;
  let http: FakeHttp;

  beforeEach(() => {
    http = new FakeHttp();
    ctx = makeTestContext({ http });
  });

  it("sends POST to openrouter.ai with Bearer auth and expected headers", async () => {
    let capturedInit: RequestInit | undefined;
    http.on("openrouter.ai", async (_url, init) => {
      capturedInit = init;
      return streamResponse(200, [
        "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]",
      ]);
    });

    const provider = new OpenRouterProvider(
      "openrouter/anthropic/claude-3.5-haiku",
      "sk-secret",
      ctx.http
    );
    await provider.complete(
      [{ role: "user", content: "Hi" }],
      [],
      () => {}
    );

    expect(capturedInit?.headers).toBeDefined();
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Title"]).toBe("Maia Agent System");
  });

  it("parses SSE data: lines and calls onToken", async () => {
    const tokens: string[] = [];
    http.on("openrouter.ai", async () =>
      streamResponse(200, [
        "data: " + JSON.stringify({
          choices: [{ delta: { content: "Hello" } }],
        }),
        "data: " + JSON.stringify({
          choices: [{ delta: { content: " world" } }],
        }),
        "data: [DONE]",
      ])
    );

    const provider = new OpenRouterProvider(
      "openrouter/anthropic/claude-3.5-haiku",
      "sk-key",
      ctx.http
    );
    const result = await provider.complete(
      [{ role: "user", content: "Say hi" }],
      [],
      (t) => tokens.push(t)
    );

    expect(tokens).toEqual(["Hello", " world"]);
    expect(result.content).toBe("Hello world");
    expect(result.stopped).toBe(true);
  });

  it("streams reasoning_details as thinking_delta (same as Ollama thinking)", async () => {
    const thinkingTokens: string[] = [];
    const contentTokens: string[] = [];
    http.on("openrouter.ai", async () =>
      streamResponse(200, [
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_details: [
                    {
                      type: "reasoning.text",
                      text: "Let me think step by step.\n",
                      format: "anthropic-claude-v1",
                      index: 0,
                    },
                  ],
                },
              },
            ],
          }),
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_details: [
                    { type: "reasoning.text", text: "First I need to...", format: "anthropic-claude-v1", index: 1 },
                  ],
                },
              },
            ],
          }),
        "data: " +
          JSON.stringify({
            choices: [{ delta: { content: "The answer is 42." } }],
          }),
        "data: [DONE]",
      ])
    );

    const provider = new OpenRouterProvider(
      "openrouter/anthropic/claude-3.5-haiku",
      "sk-key",
      ctx.http
    );
    const result = await provider.complete(
      [{ role: "user", content: "What is 6*7?" }],
      [],
      (t) => contentTokens.push(t),
      { onThinkingToken: (t) => thinkingTokens.push(t) }
    );

    expect(thinkingTokens).toEqual(["Let me think step by step.\n", "First I need to..."]);
    expect(contentTokens).toEqual(["The answer is 42."]);
    expect(result.content).toBe("The answer is 42.");
    expect(result.stopped).toBe(true);
  });

  it("emits reasoning.summary as thinking_delta when present", async () => {
    const thinkingTokens: string[] = [];
    http.on("openrouter.ai", async () =>
      streamResponse(200, [
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_details: [
                    {
                      type: "reasoning.summary",
                      summary: "Analyzed the problem and chose an approach.",
                      format: "anthropic-claude-v1",
                      index: 0,
                    },
                  ],
                },
              },
            ],
          }),
        "data: [DONE]",
      ])
    );

    const provider = new OpenRouterProvider(
      "openrouter/anthropic/claude-3.5-haiku",
      "sk-key",
      ctx.http
    );
    await provider.complete(
      [{ role: "user", content: "Hi" }],
      [],
      () => {},
      { onThinkingToken: (t) => thinkingTokens.push(t) }
    );

    expect(thinkingTokens).toEqual(["Analyzed the problem and chose an approach."]);
  });

  it("accumulates streaming tool call deltas", async () => {
    http.on("openrouter.ai", async () =>
      streamResponse(200, [
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call-1", function: { name: "foo" } },
                  ],
                },
              },
            ],
          }),
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }],
                },
              },
            ],
          }),
        "data: [DONE]",
      ])
    );

    const provider = new OpenRouterProvider(
      "openrouter/anthropic/claude-3.5-haiku",
      "sk-key",
      ctx.http
    );
    const result = await provider.complete(
      [{ role: "user", content: "Use foo" }],
      [],
      () => {}
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe("call-1");
    expect(result.toolCalls[0].name).toBe("foo");
    expect(result.toolCalls[0].args).toEqual({ x: 1 });
  });

  it("throws on HTTP error with status and body", async () => {
    http.on("openrouter.ai", async () => ({
      ok: false,
      status: 401,
      body: null,
      async text() {
        return "Invalid API key";
      },
      async json() {
        return {};
      },
    }));

    const provider = new OpenRouterProvider(
      "openrouter/anthropic/claude-3.5-haiku",
      "sk-bad",
      ctx.http
    );

    await expect(
      provider.complete([{ role: "user", content: "Hi" }], [], () => {})
    ).rejects.toThrow("OpenRouter error 401: Invalid API key");
  });

  it("strips openrouter/ prefix from model in request body", async () => {
    let model = "";
    http.on("openrouter.ai", async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      model = body.model ?? "";
      return streamResponse(200, ["data: [DONE]"]);
    });

    const provider = new OpenRouterProvider(
      "openrouter/anthropic/claude-sonnet-4-5",
      "sk-key",
      ctx.http
    );
    await provider.complete([{ role: "user", content: "x" }], [], () => {});

    expect(model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("sends openrouter/free as model when using free router", async () => {
    let model = "";
    http.on("openrouter.ai", async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      model = body.model ?? "";
      return streamResponse(200, ["data: [DONE]"]);
    });

    const provider = new OpenRouterProvider("openrouter/free", "sk-key", ctx.http);
    await provider.complete([{ role: "user", content: "x" }], [], () => {});

    expect(model).toBe("openrouter/free");
  });

  it("maps agent role to assistant in messages", async () => {
    let messages: unknown[] = [];
    http.on("openrouter.ai", async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      messages = body.messages ?? [];
      return streamResponse(200, ["data: [DONE]"]);
    });

    const provider = new OpenRouterProvider(
      "openrouter/anthropic/claude-3.5-haiku",
      "sk-key",
      ctx.http
    );
    await provider.complete(
      [
        { role: "agent", content: "Previous reply" },
        { role: "user", content: "Next" },
      ],
      [],
      () => {}
    );

    expect(messages).toContainEqual({ role: "assistant", content: "Previous reply" });
    expect(messages).toContainEqual({ role: "user", content: "Next" });
  });

  it("includes reasoning.effort when configured", async () => {
    let capturedBody: Record<string, unknown> = {};
    http.on("openrouter.ai", async (_url, init) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      return streamResponse(200, [
        "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]",
      ]);
    });

    const provider = new OpenRouterProvider(
      "openrouter/anthropic/claude-3.5-haiku",
      "sk-secret",
      ctx.http,
      "medium"
    );
    await provider.complete(
      [{ role: "user", content: "Hi" }],
      [],
      () => {}
    );

    expect(capturedBody.reasoning).toEqual({ effort: "medium" });
  });

  it("includes temperature and top_p from modelParams when provided", async () => {
    let capturedBody: Record<string, unknown> = {};
    http.on("openrouter.ai", async (_url, init) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      return streamResponse(200, [
        "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]",
      ]);
    });

    const provider = new OpenRouterProvider(
      "openrouter/anthropic/claude-3.5-haiku",
      "sk-secret",
      ctx.http,
      "medium",
      { temperature: 0.7, top_p: 0.8 }
    );
    await provider.complete(
      [{ role: "user", content: "Hi" }],
      [],
      () => {}
    );

    expect(capturedBody.temperature).toBe(0.7);
    expect(capturedBody.top_p).toBe(0.8);
  });
});
