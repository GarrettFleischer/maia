/**
 * @fileoverview Tests for the structured logging facade in `src/lib/logger.ts`.
 * Verifies level formatting, optional structured fields, and omission of undefined values.
 * @module __tests__/lib/logger
 */

import { describe, it, expect } from "bun:test";
import { debug, info, warn, error } from "@/lib/logger";

interface CapturedCall {
  method: "debug" | "info" | "warn" | "error";
  message: string;
}

/**
 * @brief Captures console output for the duration of the callback.
 * @param fn - Function that performs logging calls.
 * @returns Array of captured calls with method and first argument as string.
 */
function withCapturedConsole(fn: () => void): CapturedCall[] {
  const originalDebug = console.debug;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  const calls: CapturedCall[] = [];

  console.debug = (...args: unknown[]): void => {
    calls.push({ method: "debug", message: String(args[0]) });
  };
  console.info = (...args: unknown[]): void => {
    calls.push({ method: "info", message: String(args[0]) });
  };
  console.warn = (...args: unknown[]): void => {
    calls.push({ method: "warn", message: String(args[0]) });
  };
  console.error = (...args: unknown[]): void => {
    calls.push({ method: "error", message: String(args[0]) });
  };

  try {
    fn();
  } finally {
    console.debug = originalDebug;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }

  return calls;
}

describe("logger", () => {
  it("logs level and message for each helper", () => {
    const calls = withCapturedConsole(() => {
      debug("debug message");
      info("info message");
      warn("warn message");
      error("error message");
    });

    expect(calls).toEqual([
      expect.objectContaining({
        method: "debug",
      }),
      expect.objectContaining({
        method: "info",
      }),
      expect.objectContaining({
        method: "warn",
      }),
      expect.objectContaining({
        method: "error",
      }),
    ]);

    for (const call of calls) {
      expect(call.message).toContain(call.method.toUpperCase());
      expect(call.message).toContain("message");
      // ISO timestamp prefix should be present.
      expect(call.message).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("includes structured fields when provided", () => {
    const calls = withCapturedConsole(() => {
      info("user updated", {
        agentId: "agent-1",
        sessionId: "session-1",
        attempts: 3,
        active: true,
      });
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe("info");
    expect(call.message).toContain("agent-1");
    expect(call.message).toContain("session-1");
    expect(call.message).toContain('"attempts":3');
    expect(call.message).toContain('"active":true');
  });

  it("omits undefined structured fields", () => {
    const calls = withCapturedConsole(() => {
      debug("maybe fields", {
        agentId: "agent-2",
        sessionId: undefined,
      });
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe("debug");
    expect(call.message).toContain("agent-2");
    expect(call.message).not.toContain("sessionId");
  });
});
