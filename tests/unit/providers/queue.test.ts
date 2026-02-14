/**
 * @fileoverview Unit tests for the job-based priority queue with persistence.
 * @module tests/unit/providers/queue
 */

import { describe, it, expect } from "bun:test";
import { createRequestQueue } from "../../../src/providers/queue.js";
import { inMemoryFileSystem, fixedClock } from "../../helpers/index.js";

describe("RequestQueue", () => {
  const clock = fixedClock(new Date("2026-02-13T12:00:00.000Z"));

  describe("enqueue (fn)", () => {
    it("should run a function and return its result", async () => {
      const queue = createRequestQueue({
        maxConcurrent: 2,
        maxQueueDepth: 10,
        clock,
      });
      const result = await queue.enqueue(async () => 42);
      expect(result).toBe(42);
    });

    it("should run functions by priority (user before agent before background)", async () => {
      const queue = createRequestQueue({
        maxConcurrent: 1,
        maxQueueDepth: 10,
        clock,
      });
      const order: number[] = [];
      let releaseBlock: () => void;
      const block = new Promise<void>((r) => { releaseBlock = r; });
      queue.enqueue(async () => { await block; return 0; }, "user");
      await new Promise((r) => setTimeout(r, 0));
      queue.enqueue(async () => { order.push(1); return 1; }, "background");
      queue.enqueue(async () => { order.push(2); return 2; }, "agent");
      queue.enqueue(async () => { order.push(3); return 3; }, "user");
      releaseBlock!();
      await new Promise((r) => setTimeout(r, 30));
      expect(order).toEqual([3, 2, 1]);
    });

    it("should report depth and running correctly", async () => {
      const queue = createRequestQueue({
        maxConcurrent: 1,
        maxQueueDepth: 10,
        clock,
      });
      let resolveFirst: () => void;
      const firstDone = new Promise<void>((r) => { resolveFirst = r; });
      queue.enqueue(async () => { await firstDone; return 1; }, "user");
      await new Promise((r) => setTimeout(r, 0));
      expect(queue.running()).toBe(1);
      queue.enqueue(async () => 2, "user");
      expect(queue.depth()).toBe(1);
      resolveFirst!();
      await new Promise((r) => setTimeout(r, 5));
      expect(queue.running()).toBe(0);
      expect(queue.depth()).toBe(0);
    });

    it("should reject when queue is full", async () => {
      const queue = createRequestQueue({
        maxConcurrent: 1,
        maxQueueDepth: 2,
        clock,
      });
      let resolveA: () => void;
      const block = new Promise<void>((r) => { resolveA = r; });
      queue.enqueue(async () => { await block; return 1; });
      queue.enqueue(async () => 2);
      await expect(queue.enqueue(async () => 3)).rejects.toThrow("Queue full");
      resolveA!();
    });
  });

  describe("enqueueJob", () => {
    it("should enqueue a job and invoke the handler", async () => {
      const ran: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const queue = createRequestQueue({
        maxConcurrent: 2,
        maxQueueDepth: 10,
        clock,
        jobHandlers: {
          test_job: async (payload) => { ran.push({ type: "test_job", payload }); },
        },
      });
      await queue.enqueueJob({ type: "test_job", payload: { id: "a" } });
      await new Promise((r) => setTimeout(r, 20));
      expect(ran).toHaveLength(1);
      expect(ran[0].payload).toEqual({ id: "a" });
    });

    it("should reject when no handler for job type", async () => {
      const queue = createRequestQueue({
        maxConcurrent: 2,
        maxQueueDepth: 10,
        clock,
        jobHandlers: {},
      });
      await queue.enqueueJob({ type: "unknown_type", payload: {} });
      await new Promise((r) => setTimeout(r, 20));
      expect(queue.depth()).toBe(0);
    });

    it("should throw when queue is full", async () => {
      const queue = createRequestQueue({
        maxConcurrent: 1,
        maxQueueDepth: 1,
        clock,
        jobHandlers: { x: async () => {} },
      });
      let resolveA: () => void;
      const block = new Promise<void>((r) => { resolveA = r; });
      queue.enqueue(async () => { await block; });
      await queue.enqueueJob({ type: "x", payload: {} });
      await expect(queue.enqueueJob({ type: "x", payload: {} })).rejects.toThrow("Queue full");
      resolveA!();
    });
  });

  describe("persistence", () => {
    it("should persist pending jobs to file on enqueueJob", async () => {
      const fs = inMemoryFileSystem();
      const queue = createRequestQueue({
        maxConcurrent: 1,
        maxQueueDepth: 10,
        clock,
        persistPath: "/data/queue.json",
        fs,
        jobHandlers: { slow: async () => { await new Promise((r) => setTimeout(r, 5)); } },
      });
      await queue.enqueueJob({ type: "slow", payload: { x: 1 } });
      const content = await fs.readFile("/data/queue.json");
      const parsed = JSON.parse(content) as Array<{ type: string; payload: unknown }>;
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThanOrEqual(1);
      expect(parsed.some((j) => j.type === "slow" && (j.payload as { x: number }).x === 1)).toBe(true);
    });

    it("should load pending jobs from file and run them", async () => {
      const fs = inMemoryFileSystem();
      const ran: string[] = [];
      const queue = createRequestQueue({
        maxConcurrent: 2,
        maxQueueDepth: 10,
        clock,
        persistPath: "/data/queue.json",
        fs,
        jobHandlers: {
          loaded: async (p) => { ran.push((p.id as string) ?? "?"); },
        },
      });
      await fs.mkdir("/data").catch(() => {});
      await fs.writeFile(
        "/data/queue.json",
        JSON.stringify([
          {
            id: "job_1",
            type: "loaded",
            priority: "background",
            payload: { id: "restored-1" },
            createdAt: "2026-02-13T12:00:00.000Z",
          },
        ])
      );
      await queue.loadFromFile();
      await new Promise((r) => setTimeout(r, 25));
      expect(ran).toContain("restored-1");
      const after = await fs.readFile("/data/queue.json");
      expect(after).toBe("[]");
    });

    it("should no-op loadFromFile when persistPath or fs not set", async () => {
      const queue = createRequestQueue({
        maxConcurrent: 2,
        maxQueueDepth: 10,
        clock,
      });
      await expect(queue.loadFromFile()).resolves.toBeUndefined();
    });

    it("should no-op loadFromFile when file does not exist", async () => {
      const fs = inMemoryFileSystem();
      const queue = createRequestQueue({
        maxConcurrent: 2,
        maxQueueDepth: 10,
        clock,
        persistPath: "/nonexistent/queue.json",
        fs,
      });
      await queue.loadFromFile();
      expect(queue.depth()).toBe(0);
    });
  });

  describe("isPaused", () => {
    it("should return false when not rate-limited", () => {
      const queue = createRequestQueue({
        maxConcurrent: 2,
        maxQueueDepth: 10,
        clock,
      });
      expect(queue.isPaused()).toBe(false);
    });
  });
});
