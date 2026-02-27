/**
 * @fileoverview Tests for GET /api/ollama/metrics.
 * @module __tests__/app/api/ollama/metrics/route.test
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext, FakeHttp } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET } from "@/app/api/ollama/metrics/route";
import {
  clearOllamaJobsForTest,
  registerOllamaJobForTest,
} from "@/lib/ollama/jobs";

describe("GET /api/ollama/metrics", () => {
  beforeEach(() => {
    clearOllamaJobsForTest();
  });

  it("returns host, processes, and jobs on success", async () => {
    const http = new FakeHttp().onJson(
      "/api/ps",
      200,
      {
        models: [
          {
            name: "llama3",
            model: "llama3",
            size: 7_000_000_000,
            size_vram: 5_000_000_000,
          },
        ],
      },
    );

    const ctx = makeTestContext({ http });
    _setTestContext(ctx);

    registerOllamaJobForTest({
      id: "job-1",
      model: "ollama/llama3",
      type: "chat",
      startedAt: new Date().toISOString(),
      status: "running",
      canStop: true,
    });

    const req = createNextRequest("http://localhost/api/ollama/metrics");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      host: { cpuPercent: number; memoryUsedBytes: number; memoryTotalBytes: number };
      processes: Array<{ name: string; vramBytes: number; totalSizeBytes: number }>;
      jobs: Array<{
        id: string;
        model: string;
        type: string;
        startedAt: string;
        status: string;
        canStop: boolean;
      }>;
    };

    expect(body.host).toBeDefined();
    expect(body.host.memoryTotalBytes).toBeGreaterThan(0);

    expect(body.processes).toHaveLength(1);
    expect(body.processes[0]).toMatchObject({
      name: "llama3",
      vramBytes: 5_000_000_000,
      totalSizeBytes: 7_000_000_000,
    });

    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({
      id: "job-1",
      model: "ollama/llama3",
      type: "chat",
      status: "running",
      canStop: true,
    });
  });

  it("returns 503 when Ollama /api/ps is unavailable", async () => {
    const http = new FakeHttp().onJson(
      "/api/ps",
      500,
      { error: "Ollama unavailable" },
    );

    const ctx = makeTestContext({ http });
    _setTestContext(ctx);

    const req = createNextRequest("http://localhost/api/ollama/metrics");
    const res = await GET(req);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("handles empty models list and no jobs", async () => {
    const http = new FakeHttp().onJson(
      "/api/ps",
      200,
      { models: [] },
    );

    const ctx = makeTestContext({ http });
    _setTestContext(ctx);

    const req = createNextRequest("http://localhost/api/ollama/metrics");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processes: unknown[];
      jobs: unknown[];
    };

    expect(Array.isArray(body.processes)).toBe(true);
    expect(body.processes).toHaveLength(0);

    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs).toHaveLength(0);
  });
});

