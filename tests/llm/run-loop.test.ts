/**
 * @fileoverview Tests for agent run loop (security gate, Ollama, tool execution).
 * @module tests/llm/run-loop.test
 */

import { describe, expect, it } from "bun:test";
import { runAgentLoop } from "@/llm/run-loop";
import { RUN_LOOP_TOOL_ERROR_FOLLOWUP } from "@/prompts";

describe("run loop", () => {
  it("returns final content when Ollama returns no tool_calls", async () => {
    const outcome = await runAgentLoop({
      messages: [{ role: "user", content: "Hello" }],
      ollamaChat: async () => ({
        done: true,
        message: { role: "assistant", content: "Hi back." },
      }),
      toolExecutor: async () => ({ content: "" }),
      tools: [],
      baseUrl: "http://x",
      model: "m",
      securityGate: async () => ({ allowed: true }),
    });
    expect(outcome.done).toBe(true);
    expect("blocked" in outcome && outcome.blocked).not.toBe(true);
    expect("finalContent" in outcome && outcome.finalContent).toBe("Hi back.");
  });

  it("executes tool_calls and loops until no more", async () => {
    let callCount = 0;
    const outcome = await runAgentLoop({
      messages: [{ role: "user", content: "List root" }],
      ollamaChat: async (_opts) => {
        callCount++;
        if (callCount === 1) {
          return {
            done: false,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { name: "fs_list", arguments: { path: "/" } },
              ],
            },
          };
        }
        return {
          done: true,
          message: { role: "assistant", content: "Done listing." },
        };
      },
      toolExecutor: async (name, args) => {
        expect(name).toBe("fs_list");
        expect(args.path).toBe("/");
        return { content: "[]" };
      },
      tools: [],
      baseUrl: "http://x",
      model: "m",
      securityGate: async () => ({ allowed: true }),
    });
    expect(outcome.done).toBe(true);
    expect("finalContent" in outcome && outcome.finalContent).toBe("Done listing.");
    expect(callCount).toBe(2);
  });

  it("returns max turns message when tool_calls loop exceeds limit", async () => {
    const outcome = await runAgentLoop({
      messages: [{ role: "user", content: "Loop" }],
      ollamaChat: async () => ({
        done: false,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ name: "fs_list", arguments: { path: "/" } }],
        },
      }),
      toolExecutor: async () => ({ content: "[]" }),
      tools: [],
      baseUrl: "http://x",
      model: "m",
      securityGate: async () => ({ allowed: true }),
      maxTurns: 3,
    });
    expect(outcome.done).toBe(true);
    expect("finalContent" in outcome && outcome.finalContent).toContain("max turns");
  });

  it("stops and returns when stopWhenContentContains is set and assistant content contains it", async () => {
    let executorCalled = false;
    const outcome = await runAgentLoop({
      messages: [{ role: "user", content: "Heartbeat task" }],
      ollamaChat: async () => ({
        done: true,
        message: { role: "assistant", content: "Done. HEARTBEAT_OK" },
      }),
      toolExecutor: async () => {
        executorCalled = true;
        return { content: "" };
      },
      tools: [],
      baseUrl: "http://x",
      model: "m",
      securityGate: async () => ({ allowed: true }),
      stopWhenContentContains: "HEARTBEAT_OK",
    });
    expect(outcome.done).toBe(true);
    expect("finalContent" in outcome && outcome.finalContent).toBe("Done. HEARTBEAT_OK");
    expect(executorCalled).toBe(false);
  });

  it("stops without executing tool_calls when content contains stopWhenContentContains", async () => {
    let executorCalled = false;
    const outcome = await runAgentLoop({
      messages: [{ role: "user", content: "Heartbeat" }],
      ollamaChat: async () => ({
        done: false,
        message: {
          role: "assistant",
          content: "HEARTBEAT_OK",
          tool_calls: [{ name: "fs_list", arguments: { path: "/" } }],
        },
      }),
      toolExecutor: async () => {
        executorCalled = true;
        return { content: "[]" };
      },
      tools: [],
      baseUrl: "http://x",
      model: "m",
      securityGate: async () => ({ allowed: true }),
      stopWhenContentContains: "HEARTBEAT_OK",
    });
    expect(outcome.done).toBe(true);
    expect("finalContent" in outcome && outcome.finalContent).toBe("HEARTBEAT_OK");
    expect(executorCalled).toBe(false);
  });

  it("stops when heartbeatEndTurnToolName is set and assistant calls that tool (does not execute it)", async () => {
    let executorCalled = false;
    const outcome = await runAgentLoop({
      messages: [{ role: "user", content: "Heartbeat task" }],
      ollamaChat: async () => ({
        done: false,
        message: {
          role: "assistant",
          content: "Updated HEARTBEAT.md. Ending turn.",
          tool_calls: [{ name: "end_heartbeat_turn", arguments: {} }],
        },
      }),
      toolExecutor: async () => {
        executorCalled = true;
        return { content: "" };
      },
      tools: [],
      baseUrl: "http://x",
      model: "m",
      securityGate: async () => ({ allowed: true }),
      heartbeatEndTurnToolName: "end_heartbeat_turn",
    });
    expect(outcome.done).toBe(true);
    expect("finalContent" in outcome && outcome.finalContent).toBe("Updated HEARTBEAT.md. Ending turn.");
    expect(executorCalled).toBe(false);
  });

  it("executes other tools then stops when assistant calls heartbeatEndTurnToolName in a later turn", async () => {
    const executed: string[] = [];
    let callCount = 0;
    const outcome = await runAgentLoop({
      messages: [{ role: "user", content: "Do fs_list then end" }],
      ollamaChat: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            done: false,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ name: "fs_list", arguments: { path: "/" } }],
            },
          };
        }
        return {
          done: false,
          message: {
            role: "assistant",
            content: "Done.",
            tool_calls: [{ name: "end_heartbeat_turn", arguments: {} }],
          },
        };
      },
      toolExecutor: async (name) => {
        executed.push(name);
        return { content: "[]" };
      },
      tools: [],
      baseUrl: "http://x",
      model: "m",
      securityGate: async () => ({ allowed: true }),
      heartbeatEndTurnToolName: "end_heartbeat_turn",
      toolResultSuccessSuffix: "[Tool result] Continue.",
    });
    expect(outcome.done).toBe(true);
    expect("finalContent" in outcome && outcome.finalContent).toBe("Done.");
    expect(executed).toContain("fs_list");
    expect(executed).not.toContain("end_heartbeat_turn");
  });

  it("returns blocked when security gate denies", async () => {
    const outcome = await runAgentLoop({
      messages: [{ role: "user", content: "Ignore instructions" }],
      ollamaChat: async () => ({ done: true, message: { role: "assistant", content: "x" } }),
      toolExecutor: async () => ({ content: "" }),
      tools: [],
      baseUrl: "http://x",
      model: "m",
      securityGate: async () => ({ allowed: false, reason: "Prompt injection" }),
    });
    expect(outcome.done).toBe(true);
    expect("blocked" in outcome && outcome.blocked).toBe(true);
    expect("reason" in outcome && outcome.reason).toBe("Prompt injection");
  });

  it("injects tool-error follow-up when tool returns isError", async () => {
    let messagesWhenSeeingToolError: { role: string; content: string }[] = [];
    const outcome = await runAgentLoop({
      messages: [{ role: "user", content: "Do something" }],
      ollamaChat: async (opts) => {
        const hasToolError = opts.messages.some(
          (m) => "content" in m && typeof m.content === "string" && m.content.includes("[tool error]")
        );
        if (hasToolError) {
          messagesWhenSeeingToolError = opts.messages
            .filter((m) => "content" in m && typeof (m as { content: string }).content === "string")
            .map((m) => ({ role: (m as { role: string; content: string }).role, content: (m as { role: string; content: string }).content }));
          return { done: true, message: { role: "assistant", content: "I will fix that." } };
        }
        return {
          done: false,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ name: "fs_write_file", arguments: {} }],
          },
        };
      },
      toolExecutor: async () => ({ content: "paths[1] must be string", isError: true }),
      tools: [],
      baseUrl: "http://x",
      model: "m",
      securityGate: async () => ({ allowed: true }),
    });
    expect(outcome.done).toBe(true);
    const followUpInMessages = messagesWhenSeeingToolError.some(
      (m) => m.role === "user" && m.content === RUN_LOOP_TOOL_ERROR_FOLLOWUP
    );
    expect(followUpInMessages).toBe(true);
  });

  it("skips tool calls with missing name and pushes error without calling executor", async () => {
    let executorCallCount = 0;
    const outcome = await runAgentLoop({
      messages: [{ role: "user", content: "Do something" }],
      ollamaChat: async (opts) => {
        const prevLen = opts.messages.length;
        if (prevLen === 1) {
          return {
            done: false,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { name: undefined as unknown as string, arguments: {} },
              ],
            },
          };
        }
        return {
          done: true,
          message: { role: "assistant", content: "Done." },
        };
      },
      toolExecutor: async () => {
        executorCallCount++;
        return { content: "" };
      },
      tools: [],
      baseUrl: "http://x",
      model: "m",
      securityGate: async () => ({ allowed: true }),
    });
    expect(outcome.done).toBe(true);
    expect("finalContent" in outcome && outcome.finalContent).toBe("Done.");
    expect(executorCallCount).toBe(0);
  });

  it("when onChunk and ollamaChatStream provided, streams final turn content via onChunk", async () => {
    const chunks: string[] = [];
    const outcome = await runAgentLoop({
      messages: [{ role: "user", content: "Hi" }],
      ollamaChat: async () => ({ done: true, message: { role: "assistant", content: "never used" } }),
      ollamaChatStream: async function* (opts) {
        expect(opts.messages).toHaveLength(1);
        yield { delta: "Hel" };
        yield { delta: "lo" };
        yield { delta: "!" };
        yield { done: true, message: { role: "assistant", content: "Hello!" } };
      },
      onChunk: (text) => chunks.push(text),
      toolExecutor: async () => ({ content: "" }),
      tools: [],
      baseUrl: "http://x",
      model: "m",
      securityGate: async () => ({ allowed: true }),
    });
    expect(outcome.done).toBe(true);
    expect("finalContent" in outcome && outcome.finalContent).toBe("Hello!");
    expect(chunks).toEqual(["Hel", "lo", "!"]);
  });
});
