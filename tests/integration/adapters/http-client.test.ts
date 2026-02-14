/**
 * @fileoverview Integration tests for the real HTTP client adapter.
 * @module tests/integration/adapters/http-client
 *
 * @note Starts a local Bun HTTP server as a test fixture.
 * Tests real fetch() calls against it.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createRealHttpClient } from "../../../src/adapters/http-client.js";

describe("Real HttpClient adapter", () => {
  const client = createRealHttpClient();
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0, // random available port
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/json") {
          return new Response(JSON.stringify({ message: "hello" }), {
            status: 200,
            headers: { "Content-Type": "application/json", "X-Custom": "test-value" },
          });
        }

        if (url.pathname === "/echo" && req.method === "POST") {
          return req.text().then(
            (body) =>
              new Response(JSON.stringify({ echo: body }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              })
          );
        }

        if (url.pathname === "/error") {
          return new Response("Internal Server Error", { status: 500 });
        }

        if (url.pathname === "/slow") {
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve(new Response("eventually", { status: 200 }));
            }, 5000);
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  // ── GET request ──────────────────────────────────────────────────

  it("should perform a GET request and return body", async () => {
    const res = await client.fetch(`${baseUrl}/json`);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    const body = JSON.parse(res.body);
    expect(body.message).toBe("hello");
  });

  it("should return response headers", async () => {
    const res = await client.fetch(`${baseUrl}/json`);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["x-custom"]).toBe("test-value");
  });

  // ── POST request ─────────────────────────────────────────────────

  it("should send a POST body and receive it back", async () => {
    const res = await client.fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello from test",
    });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    const body = JSON.parse(res.body);
    expect(body.echo).toBe("hello from test");
  });

  // ── Error responses ──────────────────────────────────────────────

  it("should return ok: false for 500 responses", async () => {
    const res = await client.fetch(`${baseUrl}/error`);
    expect(res.status).toBe(500);
    expect(res.ok).toBe(false);
  });

  it("should return ok: false for 404 responses", async () => {
    const res = await client.fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
    expect(res.ok).toBe(false);
  });

  // ── Timeout ──────────────────────────────────────────────────────

  it("should abort when timeout expires", async () => {
    await expect(
      client.fetch(`${baseUrl}/slow`, { timeout: 100 })
    ).rejects.toThrow();
  });
});
