/**
 * @fileoverview Tests for POST /api/ollama/jobs/stop.
 * @module __tests__/app/api/ollama/jobs/stop/route.test
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import {
  cancelOllamaJob,
  clearOllamaJobsForTest,
  registerOllamaJobForTest,
  listOllamaJobs,
} from "@/lib/ollama/jobs";
import { POST } from "@/app/api/ollama/jobs/stop/route";

describe("POST /api/ollama/jobs/stop", () => {
  beforeEach(() => {
    clearOllamaJobsForTest();
  });

  it("returns 200 and marks job as cancelled when job exists and is stoppable", async () => {
    registerOllamaJobForTest({
      id: "job-1",
      model: "ollama/llama3",
      type: "chat",
      startedAt: new Date().toISOString(),
      status: "running",
      canStop: true,
    });

    const req = createNextRequest("http://localhost/api/ollama/jobs/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "job-1" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const jobs = listOllamaJobs();
    expect(jobs[0].status).toBe("cancelled");
    expect(jobs[0].canStop).toBe(false);
  });

  it("returns 404 when job id does not exist or is not cancellable", async () => {
    const req = createNextRequest("http://localhost/api/ollama/jobs/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "missing" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 for invalid request body", async () => {
    const req = createNextRequest("http://localhost/api/ollama/jobs/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });
});

