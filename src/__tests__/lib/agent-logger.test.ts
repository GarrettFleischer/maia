/**
 * @fileoverview Tests for agent-scoped logging with ANSI-colored prefixes.
 * Ensures logs include agent prefixes within context and fall back to raw console calls otherwise.
 * @module __tests__/lib/agent-logger
 */

import { describe, it, expect } from "bun:test";
import {
  agentDebug,
  agentError,
  agentInfo,
  runWithAgentContext,
} from "@/lib/agent/agent-logger";

interface AgentCapturedCall {
  method: "debug" | "info" | "error";
  args: unknown[];
}

/**
 * @brief Captures debug/info/error console calls during the callback.
 * @param fn - Function that performs agent logger calls.
 * @returns Array of captured calls including method and raw arguments.
 */
function withCapturedAgentConsole(
  fn: () => Promise<void> | void,
): AgentCapturedCall[] {
  const originalDebug = console.debug;
  const originalInfo = console.info;
  const originalError = console.error;

  const calls: AgentCapturedCall[] = [];

  console.debug = (...args: unknown[]): void => {
    calls.push({ method: "debug", args });
  };
  console.info = (...args: unknown[]): void => {
    calls.push({ method: "info", args });
  };
  console.error = (...args: unknown[]): void => {
    calls.push({ method: "error", args });
  };

  try {
    const result = fn();
    if (result instanceof Promise) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      result.finally(() => {
        console.debug = originalDebug;
        console.info = originalInfo;
        console.error = originalError;
      });
    } else {
      console.debug = originalDebug;
      console.info = originalInfo;
      console.error = originalError;
    }
  } finally {
    console.debug = originalDebug;
    console.info = originalInfo;
    console.error = originalError;
  }

  return calls;
}

describe("agent-logger", () => {
  it("prefixes logs with colored agent name inside context", async () => {
    const calls = withCapturedAgentConsole(async () => {
      await runWithAgentContext(
        { id: "agent-id-123", name: "TestAgent" },
        async () => {
          agentDebug("debug message");
          agentInfo("info message");
          agentError("error message");
        },
      );
    });

    expect(calls).toHaveLength(3);

    for (const call of calls) {
      const [firstArg] = call.args;
      const firstAsString = String(firstArg);
      expect(firstAsString).toMatch(/\[TestAgent\]/);
      expect(firstAsString).toMatch(/\x1b\[\d{2}m/);
      expect(firstAsString).toMatch(/\x1b\[0m/);
    }
  });

  it("falls back to raw console logging when no agent context", () => {
    const calls = withCapturedAgentConsole(() => {
      agentDebug("no context debug", { extra: true });
      agentInfo("no context info");
      agentError("no context error");
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].args[0]).toBe("no context debug");
    expect(calls[1].args[0]).toBe("no context info");
    expect(calls[2].args[0]).toBe("no context error");
  });
});
