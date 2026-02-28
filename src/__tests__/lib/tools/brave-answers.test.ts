import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { braveAnswersTool } from "@/lib/tools/brave-answers";
import { makeTestContext, FakeHttp, FakeResponse } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";
import type { BraveAnswerResult } from "@/lib/tools/brave-answers";

function makeToolCtx(http: FakeHttp): ToolContext {
  const ctx = makeTestContext({ http });
  return { ...ctx, agentId: "agent-1", sessionId: "session-1", volumeRoot: "/workspace" };
}

const BRAVE_ANSWERS_API_KEY = "test-brave-answers-key";
let savedBraveAnswersKey: string | undefined;

describe("braveAnswersTool", () => {
  let http: FakeHttp;

  beforeEach(() => {
    http = new FakeHttp();
    savedBraveAnswersKey = process.env.BRAVE_ANSWERS_API_KEY;
    process.env.BRAVE_ANSWERS_API_KEY = BRAVE_ANSWERS_API_KEY;
  });

  afterEach(() => {
    if (savedBraveAnswersKey !== undefined) process.env.BRAVE_ANSWERS_API_KEY = savedBraveAnswersKey;
    else delete process.env.BRAVE_ANSWERS_API_KEY;
  });

  it("throws when Brave Answers API key is not set", async () => {
    delete process.env.BRAVE_ANSWERS_API_KEY;
    const ctx = makeToolCtx(http);
    await expect(braveAnswersTool.execute({ q: "What is 2+2?" }, ctx)).rejects.toThrow(
      "Brave Answers API key",
    );
  });

  it("returns answer from Brave Answers API", async () => {
    const apiResponse = {
      choices: [{ message: { content: "Excess foreclosure surplus funds arise when a property sells for more than the debt and costs." } }],
    };
    http.on("api.search.brave.com", async (_url, init) => {
      const headers = init?.headers instanceof Headers ? Object.fromEntries((init.headers as Headers).entries()) : (init?.headers as Record<string, string>) ?? {};
      if (headers["X-Subscription-Token"] !== BRAVE_ANSWERS_API_KEY) return new FakeResponse(401, "Unauthorized");
      return new FakeResponse(200, JSON.stringify(apiResponse));
    });
    const ctx = makeToolCtx(http);
    const result = await braveAnswersTool.execute(
      { q: "How do excess foreclosure funds arise?" },
      ctx,
    ) as BraveAnswerResult;
    expect(result.answer).toContain("surplus");
    expect(result.fetchedAt).toBeDefined();
    expect(() => new Date(result.fetchedAt)).not.toThrow();
  });

  it("sends POST to chat/completions with model brave", async () => {
    let capturedBody: { model?: string; messages?: unknown[]; stream?: boolean; enable_research?: boolean } = {};
    http.on("api.search.brave.com", async (_url, init) => {
      const body = init?.body;
      if (typeof body === "string") capturedBody = JSON.parse(body) as typeof capturedBody;
      return new FakeResponse(200, JSON.stringify({ choices: [{ message: { content: "42" } }] }));
    });
    const ctx = makeToolCtx(http);
    await braveAnswersTool.execute({ q: "What is the answer?" }, ctx);
    expect(capturedBody.model).toBe("brave");
    expect(capturedBody.stream).toBe(false);
    expect(capturedBody.messages).toHaveLength(1);
    expect((capturedBody.messages?.[0] as { role: string; content?: string })?.content).toBe("What is the answer?");
  });

  it("accepts enableResearch flag without sending enable_research (non-streaming mode)", async () => {
    let capturedBody: { enable_research?: boolean } = {};
    http.on("api.search.brave.com", async (_url, init) => {
      const body = init?.body;
      if (typeof body === "string") capturedBody = JSON.parse(body) as typeof capturedBody;
      return new FakeResponse(200, JSON.stringify({ choices: [{ message: { content: "Done" } }] }));
    });
    const ctx = makeToolCtx(http);
    await braveAnswersTool.execute({ q: "Research this", research: true }, ctx);
    expect(capturedBody.enable_research).toBeUndefined();
  });

  it("throws when response is not ok", async () => {
    http.on("api.search.brave.com", async () => new FakeResponse(403, "Forbidden"));
    const ctx = makeToolCtx(http);
    await expect(braveAnswersTool.execute({ q: "test" }, ctx)).rejects.toThrow();
  });

  it("has correct tool definition", () => {
    const def = braveAnswersTool.toDefinition();
    expect(def.name).toBe("web_answer");
    expect(typeof def.description).toBe("string");
    expect(def.description).toContain("web search");
    expect(typeof def.parameters).toBe("object");
  });
});
