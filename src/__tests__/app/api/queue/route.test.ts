/**
 * @fileoverview Tests for GET /api/queue snapshot endpoint.
 * Ensures queue processor is started and current jobs are returned with no-store caching.
 * @module __tests__/app/api/queue/route
 */

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET } from "@/app/api/queue/route";
import * as llmQueue from "@/lib/queue/llm-queue";

describe("GET /api/queue", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("starts queue processor, ticks it once, and returns jobs snapshot", async () => {
    const startSpy = spyOn(llmQueue, "startQueueProcessor");
    const tickSpy = spyOn(llmQueue, "tickQueueProcessor");
    const jobsSpy = spyOn(llmQueue, "getQueueSnapshot").mockReturnValue([
      {
        id: "job-1",
        tool: "test_tool",
        args: { foo: "bar" },
        caller: "tester",
        priority: 1,
      },
    ]);

    const req = createNextRequest("http://localhost/api/queue");
    const res = await GET(req);

    expect(startSpy).toHaveBeenCalledWith(1000);
    expect(tickSpy).toHaveBeenCalled();
    expect(jobsSpy).toHaveBeenCalled();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<Record<string, unknown>> };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({
      id: "job-1",
      tool: "test_tool",
      caller: "tester",
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
