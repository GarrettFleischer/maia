/**
 * @fileoverview Tests for the question service (register pending, resolve with answers).
 * @module __tests__/lib/question-service
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerPendingQuestion,
  resolveQuestion,
  type AskUserQuestionInput,
} from "@/lib/question-service";

const questions: AskUserQuestionInput[] = [
  {
    id: "q1",
    prompt: "Choose one",
    choices: ["A", "B", "C"],
    allowOther: true,
  },
  { id: "q2", prompt: "Free text", allowOther: true },
];

describe("question-service", () => {
  beforeEach(() => {
    // Clear any pending state between tests (module state)
    resolveQuestion("no-such-id", { answers: {} });
  });

  it("registerPendingQuestion returns requestId and promise", () => {
    const { requestId, promise } = registerPendingQuestion(
      "session-1",
      questions,
    );
    expect(typeof requestId).toBe("string");
    expect(requestId.length).toBeGreaterThan(0);
    expect(promise).toBeInstanceOf(Promise);
  });

  it("resolveQuestion resolves the promise with answers", async () => {
    const { requestId, promise } = registerPendingQuestion(
      "session-1",
      questions,
    );
    const answers = { q1: "A", q2: "custom text" };
    resolveQuestion(requestId, { answers });
    await expect(promise).resolves.toEqual({ questions, answers });
  });

  it("resolveQuestion with unknown requestId does not resolve existing promises", async () => {
    const { requestId, promise } = registerPendingQuestion(
      "session-1",
      questions,
    );
    resolveQuestion("unknown-id", { answers: {} });
    // Promise should still be pending (no effect from unknown id)
    const result = Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 50),
      ),
    ]);
    await expect(result).rejects.toThrow("timeout");
    resolveQuestion(requestId, { answers: { q1: "A", q2: "" } });
    await promise;
  });

  it("returned answers match question ids", async () => {
    const { requestId, promise } = registerPendingQuestion("s2", questions);
    resolveQuestion(requestId, {
      answers: { q1: "Other: my choice", q2: "free" },
    });
    const out = await promise;
    expect(out.questions).toEqual(questions);
    expect(out.answers).toEqual({ q1: "Other: my choice", q2: "free" });
  });
});
