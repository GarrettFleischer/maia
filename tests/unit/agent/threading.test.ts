/**
 * @fileoverview Unit tests for conversation topic tracking.
 * @module tests/unit/agent/threading
 */

import { describe, it, expect } from "bun:test";
import { createThreadTracker } from "../../../src/agent/threading.js";

describe("Thread Tracker", () => {
  it("should create a topic thread", () => {
    const tracker = createThreadTracker();
    const thread = tracker.createThread("PostgreSQL Discussion");

    expect(thread.id).toBeDefined();
    expect(thread.topic).toBe("PostgreSQL Discussion");
  });

  it("should add messages to a thread", () => {
    const tracker = createThreadTracker();
    const thread = tracker.createThread("TypeScript Patterns");

    tracker.addMessage(thread.id, { role: "user", content: "Tell me about generics" });
    tracker.addMessage(thread.id, { role: "assistant", content: "Generics allow..." });

    const messages = tracker.getMessages(thread.id);
    expect(messages).toHaveLength(2);
  });

  it("should list active threads", () => {
    const tracker = createThreadTracker();
    tracker.createThread("Topic A");
    tracker.createThread("Topic B");

    const threads = tracker.listThreads();
    expect(threads).toHaveLength(2);
  });

  it("should find thread by topic", () => {
    const tracker = createThreadTracker();
    tracker.createThread("PostgreSQL Discussion");

    const found = tracker.findByTopic("PostgreSQL");
    expect(found).toBeDefined();
    expect(found!.topic).toContain("PostgreSQL");
  });

  it("should return undefined for unknown topic", () => {
    const tracker = createThreadTracker();
    const found = tracker.findByTopic("Unknown Topic");
    expect(found).toBeUndefined();
  });
});
