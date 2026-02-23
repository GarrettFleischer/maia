/**
 * @fileoverview Tests for Docker AI provider (OpenAI-compatible SSE streaming, tool calls).
 * @module __tests__/lib/ai/docker.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext, FakeHttp } from "../../helpers/fakes";
import type { HttpResponse } from "@/lib/context";
import { DockerProvider } from "@/lib/ai/docker";

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

describe("DockerProvider", () => {
  let ctx: ReturnType<typeof makeTestContext>;
  let http: FakeHttp;

  beforeEach(() => {
    http = new FakeHttp();
    ctx = makeTestContext({ http });
  });

  it("sends POST to baseUrl/chat/completions with expected body and no auth", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    http.on("chat/completions", async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return streamResponse(200, [
        "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]",
      ]);
    });

    const provider = new DockerProvider(
      "docker/Meta-Llama-3-8B-Instruct",
      "http://localhost:8000/v1",
      ctx.http
    );
    await provider.complete(
      [{ role: "user", content: "Hi" }],
      [],
      () => {}
    );

    expect(capturedUrl).toBe("http://localhost:8000/v1/chat/completions");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse((capturedInit?.body as string) ?? "{}");
    expect(body.model).toBe("Meta-Llama-3-8B-Instruct");
    expect(body.stream).toBe(true);
  });

  it("strips trailing slash from baseUrl", async () => {
    let capturedUrl = "";
    http.on("chat/completions", async (url) => {
      capturedUrl = url;
      return streamResponse(200, ["data: [DONE]"]);
    });

    const provider = new DockerProvider(
      "docker/my-model",
      "http://localhost:8000/v1/",
      ctx.http
    );
    await provider.complete([{ role: "user", content: "x" }], [], () => {});

    expect(capturedUrl).toBe("http://localhost:8000/v1/chat/completions");
  });

  it("parses SSE data: lines and calls onToken", async () => {
    const tokens: string[] = [];
    http.on("chat/completions", async () =>
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

    const provider = new DockerProvider(
      "docker/MyModel",
      "http://localhost:8000/v1",
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

  it("accumulates streaming tool call deltas", async () => {
    http.on("chat/completions", async () =>
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

    const provider = new DockerProvider(
      "docker/MyModel",
      "http://localhost:8000/v1",
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
    http.on("chat/completions", async () => ({
      ok: false,
      status: 503,
      body: null,
      async text() {
        return "Service unavailable";
      },
      async json() {
        return {};
      },
    }));

    const provider = new DockerProvider(
      "docker/MyModel",
      "http://localhost:8000/v1",
      ctx.http
    );

    await expect(
      provider.complete([{ role: "user", content: "Hi" }], [], () => {})
    ).rejects.toThrow("Docker error 503: Service unavailable");
  });

  it("strips docker/ prefix from model in request body", async () => {
    let model = "";
    http.on("chat/completions", async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      model = body.model ?? "";
      return streamResponse(200, ["data: [DONE]"]);
    });

    const provider = new DockerProvider(
      "docker/meta-llama/Llama-3.2-3B-Instruct",
      "http://localhost:8000/v1",
      ctx.http
    );
    await provider.complete([{ role: "user", content: "x" }], [], () => {});

    expect(model).toBe("meta-llama/Llama-3.2-3B-Instruct");
  });

  it("maps agent role to assistant in messages", async () => {
    let messages: unknown[] = [];
    http.on("chat/completions", async (_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      messages = body.messages ?? [];
      return streamResponse(200, ["data: [DONE]"]);
    });

    const provider = new DockerProvider(
      "docker/MyModel",
      "http://localhost:8000/v1",
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

  it("sends tools and tool_choice when tools provided", async () => {
    let body: Record<string, unknown> = {};
    http.on("chat/completions", async (_url, init) => {
      body = init?.body ? JSON.parse(init.body as string) : {};
      return streamResponse(200, ["data: [DONE]"]);
    });

    const provider = new DockerProvider(
      "docker/MyModel",
      "http://localhost:8000/v1",
      ctx.http
    );
    await provider.complete(
      [{ role: "user", content: "Use get_weather" }],
      [
        {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: {} },
        },
      ],
      () => {}
    );

    expect(body.tools).toBeDefined();
    expect(Array.isArray(body.tools)).toBe(true);
    expect((body.tools as unknown[]).length).toBe(1);
    expect(body.tool_choice).toBe("auto");
  });
});
