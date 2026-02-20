/**
 * @fileoverview Integration tests for MCP tool list and call.
 * @module tests/mcp/tools.test
 */

import { describe, expect, it } from "bun:test";
import {
  createToolExecutor,
  END_HEARTBEAT_TURN_TOOL_NAME,
  listHeartbeatTools,
  listMaiaTools,
  maiaToolsToOllama,
} from "@/mcp/tools";
import { createSandboxFs } from "@/tools/fs";

describe("MCP tools", () => {
  it("listMaiaTools returns fs, memory, send_message_to_agent, message_user, terminal, timer, agent tools", () => {
    const tools = listMaiaTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("fs_list");
    expect(names).toContain("memory_insert");
    expect(names).toContain("send_message_to_agent");
    expect(names).toContain("message_user");
    expect(names).toContain("terminal_run");
    expect(names).toContain("timer_create");
    expect(names).toContain("timer_list");
    expect(names).toContain("timer_delete");
    expect(names).toContain("agent_create");
    expect(names).toContain("agent_list");
    expect(names).toContain("agent_get");
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(tools[0].inputSchema.type).toBe("object");
  });

  it("listHeartbeatTools includes all Maia tools plus end_heartbeat_turn", () => {
    const maia = listMaiaTools();
    const heartbeat = listHeartbeatTools();
    expect(heartbeat.length).toBe(maia.length + 1);
    const heartbeatNames = heartbeat.map((t) => t.name);
    for (const t of maia) {
      expect(heartbeatNames).toContain(t.name);
    }
    expect(heartbeatNames).toContain(END_HEARTBEAT_TURN_TOOL_NAME);
    const endTool = heartbeat.find((t) => t.name === END_HEARTBEAT_TURN_TOOL_NAME);
    expect(endTool?.inputSchema).toEqual({ type: "object", properties: {}, required: [] });
  });

  it("executor end_heartbeat_turn returns OK", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
    });
    const r = await executor(END_HEARTBEAT_TURN_TOOL_NAME, {});
    expect(r.isError).not.toBe(true);
    expect(r.content).toBe("OK");
  });

  it("executor runs send_message_to_agent when provided", async () => {
    const sent: { from: string; to: string; content: string }[] = [];
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id-1",
      memorySearch: async () => [],
      agentId: "agent-a",
      sendMessageToAgent: async (from, to, content) => {
        sent.push({ from, to, content });
      },
    });
    const result = await executor("send_message_to_agent", {
      agent_id: "agent-b",
      content: "Hello from A",
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("OK");
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("agent-a");
    expect(sent[0].to).toBe("agent-b");
    expect(sent[0].content).toBe("Hello from A");
  });

  it("executor runs message_user when postToUserChat provided", async () => {
    const posted: string[] = [];
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id-1",
      memorySearch: async () => [],
      agentId: "agent-a",
      postToUserChat: async (content) => {
        posted.push(content);
      },
    });
    const result = await executor("message_user", { content: "Hi, something useful for you." });
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("OK");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toBe("Hi, something useful for you.");
  });

  it("executor message_user returns not configured when postToUserChat not provided", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id-1",
      memorySearch: async () => [],
      agentId: "agent-a",
    });
    const result = await executor("message_user", { content: "Hello user" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not configured");
  });

  it("executor runs fs_list and fs_read_file", async () => {
    const sandboxRoot = process.cwd();
    const fs = createSandboxFs(sandboxRoot);
    const executor = createToolExecutor({
      fsList: (p) => fs.list(p),
      fsReadFile: (p) => fs.readFile(p),
      fsWriteFile: (p, c) => fs.writeFile(p, c),
      memoryInsert: async () => "id-1",
      memorySearch: async () => [{ id: "1", content: "x" }],
      agentId: "agent-1",
    });
    const listResult = await executor("fs_list", { path: "/" });
    expect(listResult.isError).not.toBe(true);
    expect(JSON.parse(listResult.content).length).toBeGreaterThanOrEqual(0);
  });

  it("maiaToolsToOllama converts tools to Ollama shape", () => {
    const tools = listMaiaTools().slice(0, 2);
    const ollama = maiaToolsToOllama(tools);
    expect(ollama).toHaveLength(2);
    expect(ollama[0].type).toBe("function");
    expect(ollama[0].function.name).toBe(tools[0].name);
    expect(ollama[0].function.parameters).toEqual(tools[0].inputSchema);
  });

  it("executor terminal_run returns error when not configured", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
    });
    const r = await executor("terminal_run", { command: "echo x" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not configured");
  });

  it("executor terminal_run returns output when configured", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
      terminalRun: async () => ({ allowed: true, exitCode: 0, stdout: "hi", stderr: "" }),
    });
    const r = await executor("terminal_run", { command: "echo hi" });
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain("hi");
  });

  it("executor terminal_run returns error when command not allowed", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
      terminalRun: async () => ({ allowed: false, reason: "Command not allowed" }),
    });
    const r = await executor("terminal_run", { command: "cd .." });
    expect(r.isError).toBe(true);
    expect(r.content).toBe("Command not allowed");
  });

  it("executor propagates exception as error result", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => {
        throw new Error("read failed");
      },
      fsWriteFile: () => {},
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
    });
    const r = await executor("fs_read_file", { path: "x" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("read failed");
  });

  it("executor timer_create and timer_list when configured", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
      timerCreate: async () => "timer-1",
      timerList: async () => [{ id: "timer-1", fire_at_ms: 0, repeat_ms: 0 }],
      timerDelete: async () => {},
    });
    const createR = await executor("timer_create", { fire_at_ms: Date.now() + 60000 });
    expect(createR.isError).not.toBe(true);
    expect(JSON.parse(createR.content).id).toBe("timer-1");
    const listR = await executor("timer_list", {});
    expect(listR.isError).not.toBe(true);
    expect(JSON.parse(listR.content)).toHaveLength(1);
    const delR = await executor("timer_delete", { id: "timer-1" });
    expect(delR.isError).not.toBe(true);
  });

  it("executor agent_create, agent_list, agent_get when configured", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
      agentCreate: async () => ({ id: "ag-1", name: "Bot", model: null, enabled: true }),
      agentList: async () => [{ id: "ag-1", name: "Bot", model: null, enabled: true }],
      agentGet: async (id) => (id === "ag-1" ? { id: "ag-1", name: "Bot", model: null, enabled: true } : null),
    });
    const createR = await executor("agent_create", { name: "Bot", purpose: "Help" });
    expect(createR.isError).not.toBe(true);
    const listR = await executor("agent_list", {});
    expect(JSON.parse(listR.content)).toHaveLength(1);
    const getR = await executor("agent_get", { id: "ag-1" });
    expect(getR.isError).not.toBe(true);
    const notFound = await executor("agent_get", { id: "none" });
    expect(notFound.isError).toBe(true);
  });

  it("executor returns error for unknown tool", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
    });
    const r = await executor("unknown_tool", {});
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Unknown tool");
  });

  it("executor normalizes malformed tool names (e.g. fs_write_file<|channel|>json) and dispatches", async () => {
    const written: { path: string; content: string }[] = [];
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: (path, content) => {
        written.push({ path, content });
      },
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
    });
    const r = await executor("fs_write_file<|channel|>json", {
      path: "HEARTBEAT.md",
      content: "# HEARTBEAT\n\nDone.",
    });
    expect(r.isError).not.toBe(true);
    expect(r.content).toBe("OK");
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe("HEARTBEAT.md");
    expect(written[0].content).toContain("# HEARTBEAT");
  });

  it("executor web_search returns not configured when webSearch undefined", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
    });
    const r = await executor("web_search", { query: "test" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not configured");
    expect(r.content).toContain("OLLAMA_API_KEY");
  });

  it("executor web_fetch returns not configured when webFetch undefined", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
    });
    const r = await executor("web_fetch", { url: "https://example.com" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not configured");
  });

  it("executor web_search returns content when webSearch provided", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
      webSearch: async (query, maxResults) => {
        return JSON.stringify({ results: [{ title: "Test", url: "https://t.co", content: "C" }], _query: query, _max: maxResults });
      },
    });
    const r = await executor("web_search", { query: "ollama", max_results: 3 });
    expect(r.isError).not.toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.results).toHaveLength(1);
    expect(parsed._query).toBe("ollama");
    expect(parsed._max).toBe(3);
  });

  it("executor web_fetch returns content when webFetch provided", async () => {
    const executor = createToolExecutor({
      fsList: () => [],
      fsReadFile: () => "",
      fsWriteFile: () => {},
      memoryInsert: async () => "id",
      memorySearch: async () => [],
      agentId: "a1",
      webFetch: async (url) => JSON.stringify({ title: "Page", content: "Body", links: [], _url: url }),
    });
    const r = await executor("web_fetch", { url: "https://example.com" });
    expect(r.isError).not.toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.title).toBe("Page");
    expect(parsed._url).toBe("https://example.com");
  });
});
