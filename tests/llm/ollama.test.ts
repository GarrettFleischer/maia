/**
 * @fileoverview Tests for Ollama client.
 * @module tests/llm/ollama.test
 */

import { describe, expect, it } from "bun:test";
import { ollamaChat, ollamaChatStream } from "@/llm/ollama";

describe("ollama client", () => {
  it("sends messages and returns parsed response", async () => {
    const mockFetch = async (url: string, init: RequestInit) => {
      expect(url).toContain("/api/chat");
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("llama3");
      expect(body.messages).toHaveLength(1);
      return new Response(
        JSON.stringify({
          message: { role: "assistant", content: "Hi there." },
          done: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    const res = await ollamaChat(
      {
        baseUrl: "http://127.0.0.1:11434",
        model: "llama3",
        messages: [{ role: "user", content: "Hello" }],
      },
      mockFetch as unknown as typeof fetch
    );
    expect(res.done).toBe(true);
    expect(res.message.content).toBe("Hi there.");
  });

  it("throws when Ollama returns non-ok", async () => {
    const mockFetch = async () => new Response("Server error", { status: 500 });
    await expect(
      ollamaChat(
        {
          baseUrl: "http://127.0.0.1:11434",
          model: "x",
          messages: [{ role: "user", content: "Hi" }],
        },
        mockFetch as unknown as typeof fetch
      )
    ).rejects.toThrow(/Ollama error 500/);
  });

  it("includes tools in request when provided", async () => {
    const mockFetch = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.tools).toBeDefined();
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].function.name).toBe("fs_list");
      return new Response(
        JSON.stringify({
          message: { role: "assistant", content: "OK" },
          done: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    await ollamaChat(
      {
        baseUrl: "http://localhost:11434",
        model: "x",
        messages: [{ role: "user", content: "List /" }],
        tools: [
          {
            type: "function",
            function: {
              name: "fs_list",
              description: "List dir",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
        ],
      },
      mockFetch as unknown as typeof fetch
    );
  });

  describe("ollamaChatStream", () => {
    it("yields content deltas and final message from NDJSON stream", async () => {
      const mockFetch = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        expect(body.stream).toBe(true);
        const lines = [
          '{"message":{"role":"assistant","content":"Hello"},"done":false}\n',
          '{"message":{"role":"assistant","content":" world"},"done":false}\n',
          '{"message":{"role":"assistant","content":""},"done":true}\n',
        ];
        const stream = new ReadableStream({
          start(controller) {
            for (const line of lines) {
              controller.enqueue(new TextEncoder().encode(line));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        });
      };
      const chunks: string[] = [];
      let finalMessage: { content: string } | null = null;
      for await (const item of ollamaChatStream(
        {
          baseUrl: "http://127.0.0.1:11434",
          model: "llama3",
          messages: [{ role: "user", content: "Hi" }],
        },
        mockFetch as unknown as typeof fetch
      )) {
        if ("delta" in item) chunks.push(item.delta);
        if ("done" in item && item.done && item.message) finalMessage = item.message;
      }
      expect(chunks).toEqual(["Hello", " world"]);
      expect(finalMessage?.content).toBe("Hello world"); // accumulated from deltas
    });

    it("uses final chunk message.content as full content when no deltas were sent", async () => {
      const mockFetch = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        expect(body.stream).toBe(true);
        const lines = [
          '{"message":{"role":"assistant","content":""},"done":false}\n',
          '{"message":{"role":"assistant","content":"Hello from final chunk."},"done":true}\n',
        ];
        const stream = new ReadableStream({
          start(controller) {
            for (const line of lines) {
              controller.enqueue(new TextEncoder().encode(line));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        });
      };
      let finalMessage: { content: string } | null = null;
      for await (const item of ollamaChatStream(
        {
          baseUrl: "http://127.0.0.1:11434",
          model: "gpt-oss",
          messages: [{ role: "user", content: "Hi" }],
        },
        mockFetch as unknown as typeof fetch
      )) {
        if ("done" in item && item.done && item.message) finalMessage = item.message;
      }
      expect(finalMessage?.content).toBe("Hello from final chunk.");
    });

    it("parses SSE-style lines (data: prefix)", async () => {
      const mockFetch = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        expect(body.stream).toBe(true);
        const lines = [
          'data: {"message":{"role":"assistant","content":"Hi"},"done":false}\n',
          'data: {"message":{"role":"assistant","content":" there"},"done":true}\n',
        ];
        const stream = new ReadableStream({
          start(controller) {
            for (const line of lines) {
              controller.enqueue(new TextEncoder().encode(line));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      };
      const chunks: string[] = [];
      let finalMessage: { content: string } | null = null;
      for await (const item of ollamaChatStream(
        {
          baseUrl: "http://127.0.0.1:11434",
          model: "x",
          messages: [{ role: "user", content: "Hi" }],
        },
        mockFetch as unknown as typeof fetch
      )) {
        if ("delta" in item) chunks.push(item.delta);
        if ("done" in item && item.done && item.message) finalMessage = item.message;
      }
      expect(chunks).toEqual(["Hi", " there"]);
      expect(finalMessage?.content).toBe("Hi there");
    });

    it("yields final message when stream ends without done:true", async () => {
      const mockFetch = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        expect(body.stream).toBe(true);
        const lines = [
          '{"message":{"role":"assistant","content":"Partial"},"done":false}\n',
          '{"message":{"role":"assistant","content":" reply"},"done":false}\n',
        ];
        const stream = new ReadableStream({
          start(controller) {
            for (const line of lines) {
              controller.enqueue(new TextEncoder().encode(line));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      };
      const chunks: string[] = [];
      let finalMessage: { content: string } | null = null;
      for await (const item of ollamaChatStream(
        {
          baseUrl: "http://127.0.0.1:11434",
          model: "x",
          messages: [{ role: "user", content: "Hi" }],
        },
        mockFetch as unknown as typeof fetch
      )) {
        if ("delta" in item) chunks.push(item.delta);
        if ("done" in item && item.done && item.message) finalMessage = item.message;
      }
      expect(chunks).toEqual(["Partial", " reply"]);
      expect(finalMessage?.content).toBe("Partial reply");
    });

    it("parses OpenAI-style stream (choices[0].delta.content)", async () => {
      const mockFetch = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        expect(body.stream).toBe(true);
        const lines = [
          'data: {"choices":[{"delta":{"content":"Hello"},"index":0,"finish_reason":null}]}\n',
          'data: {"choices":[{"delta":{"content":" world"},"index":0,"finish_reason":null}]}\n',
          'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n',
        ];
        const stream = new ReadableStream({
          start(controller) {
            for (const line of lines) {
              controller.enqueue(new TextEncoder().encode(line));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      };
      const chunks: string[] = [];
      let finalMessage: { content: string } | null = null;
      for await (const item of ollamaChatStream(
        {
          baseUrl: "http://127.0.0.1:11434",
          model: "gpt-oss",
          messages: [{ role: "user", content: "Hi" }],
        },
        mockFetch as unknown as typeof fetch
      )) {
        if ("delta" in item) chunks.push(item.delta);
        if ("done" in item && item.done && item.message) finalMessage = item.message;
      }
      expect(chunks).toEqual(["Hello", " world"]);
      expect(finalMessage?.content).toBe("Hello world");
    });

    it("normalizes tool_calls from function-style in non-stream response", async () => {
      const mockFetch = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        expect(body.stream).toBe(false);
        return new Response(
          JSON.stringify({
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { function: { name: "fs_list", arguments: { path: "/" } } },
              ],
            },
            done: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };
      const res = await ollamaChat(
        {
          baseUrl: "http://127.0.0.1:11434",
          model: "x",
          messages: [{ role: "user", content: "List /" }],
          tools: [{ type: "function", function: { name: "fs_list", description: "List", parameters: {} } }],
        },
        mockFetch as unknown as typeof fetch
      );
      expect(res.message.tool_calls).toBeDefined();
      expect(res.message.tool_calls).toHaveLength(1);
      expect(res.message.tool_calls![0].name).toBe("fs_list");
      expect(res.message.tool_calls![0].arguments).toEqual({ path: "/" });
    });

    it("normalizes tool_calls from function-style in stream response", async () => {
      const mockFetch = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        expect(body.stream).toBe(true);
        const lines = [
          '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"fs_read_file","arguments":{"path":"/foo"}}}]},"done":true}\n',
        ];
        const stream = new ReadableStream({
          start(controller) {
            for (const line of lines) {
              controller.enqueue(new TextEncoder().encode(line));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      };
      let finalMessage: { tool_calls?: { name: string; arguments: Record<string, unknown> }[] } | null = null;
      for await (const item of ollamaChatStream(
        {
          baseUrl: "http://127.0.0.1:11434",
          model: "x",
          messages: [{ role: "user", content: "Read /foo" }],
          tools: [{ type: "function", function: { name: "fs_read_file", description: "Read", parameters: {} } }],
        },
        mockFetch as unknown as typeof fetch
      )) {
        if ("done" in item && item.done && item.message) finalMessage = item.message;
      }
      expect(finalMessage?.tool_calls).toBeDefined();
      expect(finalMessage!.tool_calls!).toHaveLength(1);
      expect(finalMessage!.tool_calls![0].name).toBe("fs_read_file");
      expect(finalMessage!.tool_calls![0].arguments).toEqual({ path: "/foo" });
    });
  });
});
