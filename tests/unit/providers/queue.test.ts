/**
 * @fileoverview Unit tests for the sync priority queue (action + args + submitterAgentId).
 * @module tests/unit/providers/queue
 *
 * @brief Tests sync queue: enqueue returns jobId, claimNext (pending->running),
 * remove on success, release on failure, depth, getJobStatus. RequestQueue has
 * three queues (user, agent, background); one worker per queue.
 */

import { describe, it, expect } from "bun:test";
import { createRequestQueue } from "../../../src/providers/queue.js";
import { fixedClock } from "../../helpers/index.js";

describe("RequestQueue", () => {
  const clock = fixedClock(new Date("2026-02-13T12:00:00.000Z"));

  describe("enqueue (sync, returns jobId)", () => {
    it("should enqueue an item and return a jobId synchronously", () => {
      const queue = createRequestQueue({
        maxQueueDepth: 10,
        clock,
      });
      const jobId = queue.enqueue("test_action", { foo: 1 }, "user", "agent-1");
      expect(typeof jobId).toBe("string");
      expect(jobId.length).toBeGreaterThan(0);
    });

    it("should store submitterAgentId on the item", () => {
      const queue = createRequestQueue({
        maxQueueDepth: 10,
        clock,
      });
      const jobId = queue.enqueue("handleChat", { msg: "hi" }, "agent", "agent-42");
      const item = queue.claimNext("agent");
      expect(item).toBeDefined();
      expect(item!.id).toBe(jobId);
      expect(item!.submitterAgentId).toBe("agent-42");
      expect(item!.action).toBe("handleChat");
      expect(item!.args).toEqual({ msg: "hi" });
    });

    it("should throw when queue is full", () => {
      const queue = createRequestQueue({
        maxQueueDepth: 2,
        clock,
      });
      queue.enqueue("a", {}, "user", "x");
      queue.enqueue("b", {}, "user", "x");
      expect(() => queue.enqueue("c", {}, "user", "x")).toThrow("Queue full");
    });
  });

  describe("claimNext", () => {
    it("should return next item from the given priority queue and move it to running", () => {
      const queue = createRequestQueue({
        maxQueueDepth: 10,
        clock,
      });
      const jobId = queue.enqueue("action1", { x: 1 }, "user", "sub-1");
      expect(queue.getJobStatus(jobId)).toBe("queued");

      const item = queue.claimNext("user");
      expect(item).toBeDefined();
      expect(item!.id).toBe(jobId);
      expect(queue.getJobStatus(jobId)).toBe("running");

      const noMore = queue.claimNext("user");
      expect(noMore).toBeUndefined();
    });

    it("should not return items from other priority queues", () => {
      const queue = createRequestQueue({
        maxQueueDepth: 10,
        clock,
      });
      queue.enqueue("user_action", {}, "user", "u");
      const fromAgent = queue.claimNext("agent");
      expect(fromAgent).toBeUndefined();
      const fromUser = queue.claimNext("user");
      expect(fromUser).toBeDefined();
      expect(fromUser!.action).toBe("user_action");
    });
  });

  describe("remove (on success)", () => {
    it("should remove the job from the queue when remove(jobId) is called", () => {
      const queue = createRequestQueue({
        maxQueueDepth: 10,
        clock,
      });
      const jobId = queue.enqueue("do", {}, "background", "sub");
      const item = queue.claimNext("background");
      expect(item!.id).toBe(jobId);
      queue.remove(jobId);
      expect(queue.getJobStatus(jobId)).toBe("not_found");
    });
  });

  describe("release (on failure, retry)", () => {
    it("should move job from running back to pending so it can be claimed again", () => {
      const queue = createRequestQueue({
        maxQueueDepth: 10,
        clock,
      });
      const jobId = queue.enqueue("retry_action", {}, "agent", "sub");
      const item = queue.claimNext("agent");
      expect(item).toBeDefined();
      expect(queue.getJobStatus(jobId)).toBe("running");

      queue.release(jobId);
      expect(queue.getJobStatus(jobId)).toBe("queued");

      const again = queue.claimNext("agent");
      expect(again).toBeDefined();
      expect(again!.id).toBe(jobId);
    });
  });

  describe("depth", () => {
    it("should report total pending + running across queues", () => {
      const queue = createRequestQueue({
        maxQueueDepth: 10,
        clock,
      });
      expect(queue.depth()).toBe(0);
      queue.enqueue("a", {}, "user", "x");
      queue.enqueue("b", {}, "user", "x");
      expect(queue.depth()).toBe(2);
      const first = queue.claimNext("user")!;
      expect(queue.depth()).toBe(2);
      queue.remove(first.id);
      expect(queue.depth()).toBe(1);
    });
  });

  describe("getJobStatus", () => {
    it("should return queued | running | not_found", () => {
      const queue = createRequestQueue({
        maxQueueDepth: 10,
        clock,
      });
      expect(queue.getJobStatus("nonexistent")).toBe("not_found");

      const jobId = queue.enqueue("act", {}, "background", "sub");
      expect(queue.getJobStatus(jobId)).toBe("queued");

      queue.claimNext("background");
      expect(queue.getJobStatus(jobId)).toBe("running");

      queue.remove(jobId);
      expect(queue.getJobStatus(jobId)).toBe("not_found");
    });
  });

  describe("three queues (user, agent, background)", () => {
    it("should route enqueue by priority to the correct queue", () => {
      const queue = createRequestQueue({
        maxQueueDepth: 10,
        clock,
      });
      queue.enqueue("u", {}, "user", "a");
      queue.enqueue("g", {}, "agent", "a");
      queue.enqueue("b", {}, "background", "a");

      expect(queue.claimNext("user")!.action).toBe("u");
      expect(queue.claimNext("agent")!.action).toBe("g");
      expect(queue.claimNext("background")!.action).toBe("b");
    });
  });
});
