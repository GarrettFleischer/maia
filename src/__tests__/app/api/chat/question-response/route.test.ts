/**
 * @fileoverview Tests for POST /api/chat/question-response (submit user answers for ask_user tool).
 * @module __tests__/app/api/chat/question-response/route.test
 */
import { describe, it, expect } from "bun:test";
import {
  registerPendingQuestion,
  resolveQuestion,
} from "@/lib/question-service";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { POST } from "@/app/api/chat/question-response/route";

describe("POST /api/chat/question-response", () => {
  it("returns 400 on invalid body", async () => {
    const req = createNextRequest(
      "http://localhost/api/chat/question-response",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 200 and resolves pending question", async () => {
    const { requestId, promise } = registerPendingQuestion("session-1", [
      { id: "q1", prompt: "Pick", choices: ["A", "B"], allowOther: true },
    ]);

    const req = createNextRequest(
      "http://localhost/api/chat/question-response",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "session-1",
          requestId,
          answers: { q1: "B" },
        }),
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(200);

    const result = await promise;
    expect(result.answers).toEqual({ q1: "B" });
  });
});
