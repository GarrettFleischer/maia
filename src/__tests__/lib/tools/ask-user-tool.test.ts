/**
 * @fileoverview Tests for ask_user tool: schema, event emission, and result shape.
 * @module __tests__/lib/tools/ask-user-tool
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { askUserTool } from "@/lib/tools/ask-user-tool";
import { resolveQuestion } from "@/lib/question-service";
import { makeTestContext } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";

function makeCtx(sessionId = "session-1"): ToolContext {
  const ctx = makeTestContext();
  return { ...ctx, agentId: "agent-1", sessionId, volumeRoot: "/workspace" };
}

describe("askUserTool", () => {
  beforeEach(() => {
    resolveQuestion("any", { answers: {} });
  });

  it("emits question event and returns user answers when resolved", async () => {
    const ctx = makeCtx("s1");
    const emitted: unknown[] = [];
    ctx.events.subscribe((e) => emitted.push(e));

    const questions = [
      { id: "q1", prompt: "Pick", choices: ["A", "B"], allowOther: true },
      { id: "q2", prompt: "Free", allowOther: true },
    ];

    const resultPromise = askUserTool.execute({ questions }, ctx);

    const questionEvent = emitted.find(
      (
        e,
      ): e is {
        event: string;
        data: { requestId: string; sessionId: string; questions: unknown[] };
      } =>
        typeof e === "object" &&
        e !== null &&
        "event" in e &&
        (e as { event: string }).event === "question",
    );
    expect(questionEvent).toBeDefined();
    expect(questionEvent?.data.sessionId).toBe("s1");
    expect(questionEvent?.data.questions).toHaveLength(2);

    const requestId = questionEvent?.data.requestId;
    expect(requestId).toBeDefined();
    resolveQuestion(requestId!, { answers: { q1: "B", q2: "my text" } });

    const result = await resultPromise;
    expect(result.questions).toHaveLength(2);
    expect(result.answers).toEqual({ q1: "B", q2: "my text" });
  });

  it("has correct tool definition", () => {
    const def = askUserTool.toDefinition();
    expect(def.name).toBe("ask_user");
    expect(def.parameters).toBeDefined();
    expect(def.parameters.properties?.questions).toBeDefined();
  });

  it("schema rejects empty questions array", () => {
    expect(() => askUserTool.schema.parse({ questions: [] })).toThrow();
  });
});
