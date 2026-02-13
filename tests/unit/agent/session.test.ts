/**
 * @fileoverview Unit tests for session management, compaction, and context window awareness.
 * @module tests/unit/agent/session
 */

import { describe, it, expect } from "bun:test";
import { createSessionManager } from "../../../src/agent/session.js";
import { capturingLogger, fixedClock } from "../../helpers/index.js";

describe("Session Manager", () => {
  function makeSession() {
    const logger = capturingLogger();
    const clock = fixedClock();
    const session = createSessionManager({
      contextWindowSize: 4096,
      compactionThresholdPercent: 80,
      preserveRecentMessages: 3,
      logger,
      clock,
    });
    return { session, logger };
  }

  it("should create a new session with a unique id", () => {
    const { session } = makeSession();
    const s = session.create();
    expect(s.id).toBeDefined();
    expect(s.messages).toEqual([]);
  });

  it("should add messages to a session", () => {
    const { session } = makeSession();
    const s = session.create();

    session.addMessage(s.id, { role: "user", content: "Hello" });
    session.addMessage(s.id, { role: "assistant", content: "Hi there!" });

    const messages = session.getMessages(s.id);
    expect(messages).toHaveLength(2);
  });

  it("should estimate token count", () => {
    const { session } = makeSession();
    const s = session.create();

    session.addMessage(s.id, { role: "user", content: "Hello world" });

    const estimate = session.estimateTokens(s.id);
    expect(estimate).toBeGreaterThan(0);
  });

  it("should detect when compaction is needed", () => {
    const { session } = makeSession();
    const s = session.create();

    // Add lots of messages to exceed threshold
    for (let i = 0; i < 100; i++) {
      session.addMessage(s.id, {
        role: "user",
        content: "This is a long message that takes up tokens. ".repeat(10),
      });
    }

    expect(session.needsCompaction(s.id)).toBe(true);
  });

  it("should not need compaction for short conversations", () => {
    const { session } = makeSession();
    const s = session.create();

    session.addMessage(s.id, { role: "user", content: "Hi" });
    session.addMessage(s.id, { role: "assistant", content: "Hello!" });

    expect(session.needsCompaction(s.id)).toBe(false);
  });

  it("should compact by preserving recent messages", async () => {
    const { session } = makeSession();
    const s = session.create();

    for (let i = 0; i < 10; i++) {
      session.addMessage(s.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
      });
    }

    const summary = "Summary of older messages.";
    await session.compact(s.id, summary);

    const messages = session.getMessages(s.id);
    // Should have summary + preserved recent messages
    expect(messages.length).toBeLessThanOrEqual(4); // summary + 3 recent
    expect(messages[0].content).toContain("Summary");
  });

  it("should throw for nonexistent session id", () => {
    const { session } = makeSession();
    expect(() => session.getMessages("nonexistent")).toThrow();
  });
});
