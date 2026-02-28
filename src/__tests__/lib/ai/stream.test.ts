/**
 * @fileoverview Tests for unified stream API (stream adapter).
 * @module __tests__/lib/ai/stream.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext, FakeHttp } from "../../helpers/fakes";
import type { HttpResponse } from "@/lib/context";
import { stream } from "@/lib/ai/stream";
import { updateSettings } from "@/lib/settings";

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

describe("stream (unified API)", () => {
  let ctx: ReturnType<typeof makeTestContext>;
  let http: FakeHttp;

  beforeEach(() => {
    http = new FakeHttp();
    ctx = makeTestContext({ http });
  });

  it("yields text_delta and stop for Ollama model", async () => {
    http.on(/\/api\/chat/, async () =>
      streamResponse(200, [
        JSON.stringify({ message: { content: "Hello" }, done: false }),
        JSON.stringify({ message: { content: " world" }, done: true }),
      ])
    );

    const events: Array<{ type: string; delta?: string }> = [];
    for await (const e of stream(
      "ollama/llama3.2",
      ctx,
      [{ role: "user", content: "Hi" }],
      []
    )) {
      events.push(e.type === "text_delta" ? { type: e.type, delta: e.delta } : { type: e.type });
    }
    expect(events).toEqual([
      { type: "text_delta", delta: "Hello" },
      { type: "text_delta", delta: " world" },
      { type: "stop" },
    ]);
  });

  it("throws for unknown model prefix when model is whitelisted", async () => {
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2", "custom/my-model"] });
    await expect(
      (async () => {
        for await (const _ of stream(
          "custom/my-model",
          ctx,
          [{ role: "user", content: "Hi" }],
          []
        )) {
          // consume
        }
      })()
    ).rejects.toThrow("Unknown model provider");
  });
});
