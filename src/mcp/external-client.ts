/**
 * @fileoverview External MCP client: list and call tools via stdio or HTTP transport.
 * @module mcp/external-client
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export type McpToolDef = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpToolCallResult = {
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
};

export type ExternalMcpConfig = {
  name: string;
  transport: "stdio" | "http";
  /** For stdio: command + args to spawn (e.g. ["node", "server.js"]) */
  command?: string[];
  /** For http: base URL for JSON-RPC (e.g. https://example.com/mcp) */
  url?: string;
};

export type ExternalMcpClient = {
  listTools: () => Promise<McpToolDef[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolCallResult>;
  /** Close stdio process if any; no-op for HTTP */
  close: () => void;
};

function nextId(): number {
  return Math.floor(Math.random() * 1e9);
}

/**
 * HTTP transport: POST JSON-RPC to url.
 */
async function httpRequest(url: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = nextId();
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (data.error) throw new Error(`MCP error: ${data.error.message}`);
  return data.result;
}

/**
 * Stdio transport: spawn process, write JSON-RPC line, read JSON-RPC line.
 */
function stdioRequest(
  proc: ChildProcess,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    if (!proc.stdin) {
      reject(new Error("No stdin"));
      return;
    }
    const onData = (chunk: Buffer | string) => {
      const line = chunk.toString().trim();
      if (!line) return;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (msg.id === id) {
          cleanup();
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch (e) {
        cleanup();
        reject(e);
      }
    };
    const cleanup = () => {
      proc.stdout?.off("data", onData);
      proc.stderr?.off("data", onData);
      proc.off("error", onErr);
      proc.off("close", onClose);
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = (code: number | null) => {
      cleanup();
      if (code !== 0 && code !== null) reject(new Error(`Process exited ${code}`));
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", onErr);
    proc.on("close", onClose);
    proc.stdin.write(request, (err) => {
      if (err) {
        cleanup();
        reject(err);
      }
    });
  });
}

/**
 * Creates an external MCP client (stdio or HTTP). For stdio, the process is spawned on first use and kept until close().
 */
export function createExternalMcpClient(config: ExternalMcpConfig): ExternalMcpClient {
  let proc: ChildProcess | null = null;

  function getProc(): ChildProcess {
    if (config.transport !== "stdio" || !config.command?.length) {
      throw new Error("Stdio transport requires command");
    }
    if (!proc) {
      proc = spawn(config.command[0], config.command.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    return proc;
  }

  async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (config.transport === "http") {
      if (!config.url) throw new Error("HTTP transport requires url");
      return httpRequest(config.url, method, params);
    }
    return stdioRequest(getProc(), method, params);
  }

  return {
    async listTools(): Promise<McpToolDef[]> {
      const result = await request("tools/list", {}) as { tools?: McpToolDef[] };
      return result?.tools ?? [];
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
      const result = await request("tools/call", { name, arguments: args }) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      return {
        content: result?.content ?? [],
        isError: result?.isError ?? false,
      };
    },

    close() {
      if (proc) {
        proc.kill();
        proc = null;
      }
    },
  };
}
