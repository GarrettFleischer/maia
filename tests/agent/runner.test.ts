/**
 * @fileoverview Tests for agent runner (buildAgentExecutor, runAgent).
 * @module tests/agent/runner.test
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { buildAgentExecutor, runAgent } from "@/agent/runner";

describe("agent runner", () => {
  const sandboxRoot = path.join(process.cwd(), "tmp-agent-runner-" + Date.now());

  beforeEach(() => {
    fs.mkdirSync(sandboxRoot, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("buildAgentExecutor returns executor that runs fs_list", async () => {
    const agentId = "agent-1";
    const agentDir = path.join(sandboxRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    const deps = {
      agentId,
      sandboxRoot,
      model: "llama3",
      defaultModel: "llama3",
      ollamaBaseUrl: "http://127.0.0.1:11434",
      securityGateModel: "llama3",
      mdContext: {},
      messages: [],
    };
    const executor = buildAgentExecutor(deps);
    const result = await executor("fs_list", { path: "/" });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content)).toEqual([]);
  });

  it("buildAgentExecutor with forbidFsReadFileInWorkspace returns already-in-context for HEARTBEAT.md/SOUL.md", async () => {
    const agentId = "agent-1";
    const agentDir = path.join(sandboxRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "HEARTBEAT.md"), "secret heartbeat content", "utf-8");
    fs.writeFileSync(path.join(agentDir, "SOUL.md"), "secret soul content", "utf-8");
    fs.writeFileSync(path.join(agentDir, "USER.md"), "user content", "utf-8");
    const deps = {
      agentId,
      sandboxRoot,
      model: "llama3",
      defaultModel: "llama3",
      ollamaBaseUrl: "http://127.0.0.1:11434",
      securityGateModel: "llama3",
      mdContext: {},
      messages: [],
      forbidFsReadFileInWorkspace: ["HEARTBEAT.md", "SOUL.md"],
    };
    const executor = buildAgentExecutor(deps);
    const heartbeatResult = await executor("fs_read_file", { path: "HEARTBEAT.md" });
    expect(heartbeatResult.content).toBe("You already have this file in context; do not re-read it.");
    const soulResult = await executor("fs_read_file", { path: "SOUL.md" });
    expect(soulResult.content).toBe("You already have this file in context; do not re-read it.");
    const otherResult = await executor("fs_read_file", { path: "USER.md" });
    expect(otherResult.content).toBe("user content");
  });

  it("buildAgentExecutor with sendMessageToAgent appends to conversation", async () => {
    const agentId = "agent-1";
    const agentDir = path.join(sandboxRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    const appended: { convId: string; content: string }[] = [];
    const deps = {
      agentId,
      sandboxRoot,
      model: "llama3",
      defaultModel: "llama3",
      ollamaBaseUrl: "http://127.0.0.1:11434",
      securityGateModel: "llama3",
      mdContext: {},
      messages: [],
      conversationRepo: {
        getOrCreate: async (a: string, _t: string, to: string | null) => {
          const id = `conv-${a}-${to}`;
          return id;
        },
      },
      messageRepo: {
        append: async (convId: string, payload: { content?: string | null }) => {
          appended.push({ convId, content: payload.content ?? "" });
        },
      },
    };
    const executor = buildAgentExecutor(deps);
    await executor("send_message_to_agent", { agent_id: "agent-2", content: "Hi" });
    expect(appended).toHaveLength(1);
    expect(appended[0].content).toBe("Hi");
  });

  it("runAgent returns error when Ollama fails", async () => {
    const agentId = "agent-1";
    const agentDir = path.join(sandboxRoot, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    const outcome = await runAgent({
      agentId,
      sandboxRoot,
      model: "llama3",
      defaultModel: "llama3",
      ollamaBaseUrl: "http://127.0.0.1:99999",
      securityGateModel: "llama3",
      mdContext: { "IDENTITY.md": "Test agent" },
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(outcome.ok).toBe(false);
    expect("error" in outcome && outcome.error).toBeDefined();
  });
});
