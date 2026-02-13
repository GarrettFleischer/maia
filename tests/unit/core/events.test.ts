/**
 * @fileoverview Unit tests for the event emitter (Observer pattern).
 * @module tests/unit/core/events
 */

import { describe, it, expect } from "bun:test";
import { createEventBus } from "../../../src/core/events.js";

describe("EventBus", () => {
  it("should register and call event handlers", async () => {
    const bus = createEventBus();
    const calls: unknown[] = [];

    bus.on("messageReceived", (data) => {
      calls.push(data);
    });

    await bus.emit("messageReceived", { content: "hello" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ content: "hello" });
  });

  it("should support multiple handlers for the same event", async () => {
    const bus = createEventBus();
    let count = 0;

    bus.on("messageReceived", () => { count++; });
    bus.on("messageReceived", () => { count++; });

    await bus.emit("messageReceived", {});

    expect(count).toBe(2);
  });

  it("should not call handlers for different events", async () => {
    const bus = createEventBus();
    let called = false;

    bus.on("messageSent", () => { called = true; });

    await bus.emit("messageReceived", {});

    expect(called).toBe(false);
  });

  it("should remove handlers with off()", async () => {
    const bus = createEventBus();
    let count = 0;

    const handler = () => { count++; };
    bus.on("messageReceived", handler);
    bus.off("messageReceived", handler);

    await bus.emit("messageReceived", {});

    expect(count).toBe(0);
  });

  it("should handle async handlers", async () => {
    const bus = createEventBus();
    const results: number[] = [];

    bus.on("messageReceived", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      results.push(1);
    });

    await bus.emit("messageReceived", {});

    expect(results).toEqual([1]);
  });

  it("should not throw when emitting with no handlers", async () => {
    const bus = createEventBus();
    // Should not throw
    await bus.emit("messageReceived", {});
  });
});
