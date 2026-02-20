/**
 * @fileoverview Tests for external MCP client (stdio and HTTP).
 * @module tests/mcp/external-client.test
 */

import { describe, expect, it } from "bun:test";
import { createExternalMcpClient } from "@/mcp/external-client";

describe("external MCP client (HTTP)", () => {
  it("lists tools from HTTP server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/mcp") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                tools: [
                  { name: "get_weather", description: "Get weather", inputSchema: { type: "object" } },
                ],
              },
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });
    const baseUrl = `http://localhost:${server.port}`;
    const client = createExternalMcpClient({
      name: "test",
      transport: "http",
      url: baseUrl + "/mcp",
    });
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("get_weather");
    server.stop();
  });

  it("calls tool via HTTP", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/mcp") {
          const body = req.json() as Promise<{ method?: string; params?: { name?: string } }>;
          return body.then((b) => {
            if (b.method === "tools/call" && b.params?.name === "get_weather") {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  result: {
                    content: [{ type: "text", text: "72°F" }],
                    isError: false,
                  },
                }),
                { headers: { "Content-Type": "application/json" } }
              );
            }
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } }), { status: 200, headers: { "Content-Type": "application/json" } });
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    const client = createExternalMcpClient({
      name: "test",
      transport: "http",
      url: `http://localhost:${server.port}/mcp`,
    });
    const result = await client.callTool("get_weather", { location: "NYC" });
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { type: "text"; text: string }).text).toBe("72°F");
    server.stop();
  });
});

describe("external MCP client (stdio)", () => {
  it("lists tools from stdio server", async () => {
    const path = await import("node:path");
    const scriptPath = path.join(process.cwd(), "tests", "mcp", "stdio-echo.mjs");
    const client = createExternalMcpClient({
      name: "echo-server",
      transport: "stdio",
      command: ["node", scriptPath],
    });
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("stdio_tool");
    client.close();
  });
});
