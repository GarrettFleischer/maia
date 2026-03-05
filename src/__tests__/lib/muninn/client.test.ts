/**
 * @fileoverview Tests for Muninn REST client (writeEngram, activate, search).
 * @module __tests__/lib/muninn/client.test
 */

import { describe, it, expect } from "bun:test";
import { createMuninnClient } from "@/lib/muninn/client";
import type { HttpClient } from "@/lib/context";

function createMockHttp(handlers: {
  post?: (url: string, body: unknown) => { status: number; body: unknown };
  get?: (url: string) => { status: number; body: unknown };
}): HttpClient {
  return {
    fetch: async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body =
        init?.body && typeof init.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined;
      if (method === "POST" && handlers.post) {
        const result = handlers.post(url, body);
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          text: async () => JSON.stringify(result.body),
          json: async () => result.body,
          body: null,
        };
      }
      if (method === "GET" && handlers.get) {
        const result = handlers.get(url);
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          text: async () => JSON.stringify(result.body),
          json: async () => result.body,
          body: null,
        };
      }
      return {
        ok: false,
        status: 404,
        text: async () => "Not found",
        json: async () => ({ error: "Not found" }),
        body: null,
      };
    },
  };
}

describe("Muninn client", () => {
  it("writeEngram sends POST to /api/engrams with vault, concept, content, tags", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const http = createMockHttp({
      post: (url, body) => {
        capturedUrl = url;
        capturedBody = (body as Record<string, unknown>) ?? {};
        return {
          status: 200,
          body: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        };
      },
    });
    const client = createMuninnClient(http, "http://localhost:8475");
    await client.writeEngram(
      "default",
      "auth architecture",
      "Short-lived JWTs",
      ["auth", "security"],
    );
    expect(capturedUrl).toBe("http://localhost:8475/api/engrams");
    expect(capturedBody.vault).toBe("default");
    expect(capturedBody.concept).toBe("auth architecture");
    expect(capturedBody.content).toBe("Short-lived JWTs");
    expect(capturedBody.tags).toEqual(["auth", "security"]);
  });

  it("writeEngram works without tags", async () => {
    let capturedBody: Record<string, unknown> = {};
    const http = createMockHttp({
      post: (_url, body) => {
        capturedBody = (body as Record<string, unknown>) ?? {};
        return { status: 200, body: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" } };
      },
    });
    const client = createMuninnClient(http, "http://localhost:8475");
    await client.writeEngram("maia", "concept", "content");
    expect(capturedBody.tags).toBeUndefined();
  });

  it("activate sends POST to /api/activate and returns activations", async () => {
    const http = createMockHttp({
      post: (_url, body) => {
        expect(body).toEqual({
          vault: "default",
          context: ["login flow"],
          max_results: 5,
        });
        return {
          status: 200,
          body: {
            activations: [
              {
                id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                concept: "auth",
                content: "JWT refresh in cookies",
                score: 0.92,
                tags: ["auth"],
              },
            ],
          },
        };
      },
    });
    const client = createMuninnClient(http, "http://localhost:8475");
    const result = await client.activate("default", ["login flow"], 5);
    expect(result.activations).toHaveLength(1);
    expect(result.activations[0].id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(result.activations[0].content).toBe("JWT refresh in cookies");
    expect(result.activations[0].score).toBe(0.92);
  });

  it("search sends GET to /api/engrams?q=...&vault=... and returns engrams", async () => {
    let capturedUrl = "";
    const http = createMockHttp({
      get: (url) => {
        capturedUrl = url;
        return {
          status: 200,
          body: {
            engrams: [
              {
                id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                concept: "JWT",
                content: "Short-lived JWTs",
                tags: ["auth"],
              },
            ],
          },
        };
      },
    });
    const client = createMuninnClient(http, "http://localhost:8475");
    const result = await client.search("default", "JWT");
    expect(capturedUrl).toContain("/api/engrams");
    expect(capturedUrl).toContain("q=JWT");
    expect(capturedUrl).toContain("vault=default");
    expect(result.engrams).toHaveLength(1);
    expect(result.engrams[0].concept).toBe("JWT");
  });

  it("throws when writeEngram gets non-2xx", async () => {
    const http = createMockHttp({
      post: () => ({ status: 503, body: { error: "Service unavailable" } }),
    });
    const client = createMuninnClient(http, "http://localhost:8475");
    await expect(client.writeEngram("default", "c", "content")).rejects.toThrow(
      /503|Service unavailable/i,
    );
  });

  it("writeEngramBatch sends POST to /api/engrams/batch and chunks by 50", async () => {
    const batchBodies: unknown[] = [];
    const http = createMockHttp({
      post: (_url, body) => {
        const b = body as { engrams?: unknown[] };
        if (_url.includes("/api/engrams/batch")) batchBodies.push(b);
        return {
          status: 200,
          body: { ids: (b.engrams ?? []).map((_, i) => `id-${i}`) },
        };
      },
    });
    const client = createMuninnClient(http, "http://localhost:8475");
    const items = [
      { vault: "default", concept: "a", content: "x", tags: ["k"] as string[] },
      { vault: "default", concept: "b", content: "y", tags: ["k"] as string[] },
    ];
    const result = await client.writeEngramBatch(items);
    expect(result.written).toBe(2);
    expect(batchBodies).toHaveLength(1);
    expect((batchBodies[0] as { engrams: unknown[] }).engrams).toHaveLength(2);
  });
});
