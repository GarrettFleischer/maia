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
});
