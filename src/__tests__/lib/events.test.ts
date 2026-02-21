/**
 * @fileoverview Tests for the global SSE event bus (emit/subscribe/unsubscribe).
 * @module __tests__/lib/events
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { globalEventBus, subscribe, emit } from "@/lib/events";
import type { SystemSSEEvent } from "@/lib/types";

/** Minimal event for tests. */
function pingEvent(ts = new Date().toISOString()): SystemSSEEvent {
  return { event: "ping", data: { timestamp: ts } };
}

describe("events", () => {
  const unsubscribes: Array<() => void> = [];

  afterEach(() => {
    for (const unsub of unsubscribes) unsub();
    unsubscribes.length = 0;
  });

  describe("globalEventBus", () => {
    it("delivers emitted events to subscribed listeners", () => {
      const received: SystemSSEEvent[] = [];
      unsubscribes.push(
        globalEventBus.subscribe((event) => {
          received.push(event);
        })
      );
      const ev = pingEvent();
      globalEventBus.emit(ev);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(ev);
    });

    it("delivers to multiple listeners", () => {
      const a: SystemSSEEvent[] = [];
      const b: SystemSSEEvent[] = [];
      unsubscribes.push(globalEventBus.subscribe((e) => a.push(e)));
      unsubscribes.push(globalEventBus.subscribe((e) => b.push(e)));
      const ev = pingEvent();
      globalEventBus.emit(ev);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0]).toBe(ev);
      expect(b[0]).toBe(ev);
    });

    it("stops delivery after unsubscribe", () => {
      const received: SystemSSEEvent[] = [];
      const unsub = globalEventBus.subscribe((e) => received.push(e));
      unsubscribes.push(unsub);
      globalEventBus.emit(pingEvent());
      expect(received).toHaveLength(1);
      unsub();
      globalEventBus.emit(pingEvent());
      expect(received).toHaveLength(1);
    });

    it("ignores listener errors and still notifies other listeners", () => {
      const received: SystemSSEEvent[] = [];
      unsubscribes.push(
        globalEventBus.subscribe(() => {
          throw new Error("listener error");
        })
      );
      unsubscribes.push(globalEventBus.subscribe((e) => received.push(e)));
      globalEventBus.emit(pingEvent());
      expect(received).toHaveLength(1);
    });
  });

  describe("subscribe (legacy)", () => {
    it("returns unsubscribe that stops delivery", () => {
      const received: SystemSSEEvent[] = [];
      const unsub = subscribe((e) => received.push(e));
      unsubscribes.push(unsub);
      emit(pingEvent());
      expect(received).toHaveLength(1);
      unsub();
      emit(pingEvent());
      expect(received).toHaveLength(1);
    });
  });

  describe("emit (legacy)", () => {
    it("delivers event to globalEventBus subscribers", () => {
      const received: SystemSSEEvent[] = [];
      unsubscribes.push(globalEventBus.subscribe((e) => received.push(e)));
      const ev = pingEvent();
      emit(ev);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(ev);
    });
  });
});
