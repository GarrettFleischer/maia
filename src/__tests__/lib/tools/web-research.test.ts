import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { webResearchTool } from "@/lib/tools/web-research";
import { makeTestContext, FakeHttp, FakeResponse } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";
import type { BraveAnswerResult } from "@/lib/tools/brave-answers";

function makeToolCtx(http: FakeHttp): ToolContext {
  const ctx = makeTestContext({ http });
  return { ...ctx, agentId: "agent-1", sessionId: "session-1", volumeRoot: "/workspace" };
}

const BRAVE_ANSWERS_API_KEY = "test-brave-answers-key";
let savedBraveAnswersKey: string | undefined;

describe("webResearchTool", () => {
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
    await expect(webResearchTool.execute({ question: "What is 2+2?" }, ctx)).rejects.toThrow(
      "Brave Answers API key",
    );
  });

  it("sends POST to chat/completions with stream true and enable_research", async () => {
    let capturedBody: {
      model?: string;
      messages?: unknown[];
      stream?: boolean;
      enable_research?: boolean;
      enable_citations?: boolean;
    } = {};
    http.on("api.search.brave.com", async (_url, init) => {
      const body = init?.body;
      if (typeof body === "string") capturedBody = JSON.parse(body) as typeof capturedBody;
      return new FakeResponse(
        200,
        [
          'data: {"choices":[{"delta":{"content":"Hello "}}]}',
          "",
          'data: {"choices":[{"delta":{"content":"world"}}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      );
    });
    const ctx = makeToolCtx(http);
    const result = (await webResearchTool.execute(
      { question: "Explain quantum computing", enableCitations: true },
      ctx,
    )) as BraveAnswerResult;
    expect(capturedBody.model).toBe("brave");
    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.messages).toHaveLength(1);
    expect((capturedBody.messages?.[0] as { role: string; content: string })?.content).toBe(
      "Explain quantum computing",
    );
    expect(capturedBody.enable_research).toBe(true);
    expect(result.answer).toBe("Hello world");
    expect(result.fetchedAt).toBeDefined();
  });
});

