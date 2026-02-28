/**
 * @fileoverview Tests for the LLM priority queue (enqueue, priority ordering, embedding-ready gate).
 * @module __tests__/lib/queue/llm-queue
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  enqueue,
  isEmbeddingReady,
  setEmbeddingReady,
  getPriority,
  getQueueSnapshot,
  startQueueProcessor,
  tickQueueProcessor,
  _resetEmbeddingReadyForTests,
  _resetQueueForTests,
} from "@/lib/queue/llm-queue";
import { registerLlmQueueHandlers } from "@/lib/queue/llm-queue-handlers";
import { makeTestContext } from "../../helpers/fakes";

describe("llm-queue", () => {
  let ctx: ReturnType<typeof makeTestContext>;

  beforeEach(() => {
    _resetQueueForTests();
    _resetEmbeddingReadyForTests();
    registerLlmQueueHandlers();
    ctx = makeTestContext();
  });

  const getCtx = () => ctx;

  describe("getPriority", () => {
    it("returns 1 for embedding tools", () => {
      expect(
        getPriority({ tool: "refreshEmbeddings", args: {}, caller: "system" }),
      ).toBe(1);
      expect(
        getPriority({
          tool: "buildRawRetrievedContext",
          args: {},
          caller: "user",
        }),
      ).toBe(1);
    });

    it("returns 2 for smart context tools", () => {
      expect(
        getPriority({ tool: "extractSearchQueries", args: {}, caller: "user" }),
      ).toBe(2);
    });

    it("returns 3 for runAgent with user caller", () => {
      expect(getPriority({ tool: "runAgent", args: {}, caller: "user" })).toBe(
        3,
      );
    });

    it("returns 4 for runAgent with maia caller", () => {
      expect(getPriority({ tool: "runAgent", args: {}, caller: "maia" })).toBe(
        4,
      );
    });

    it("returns 5 for runAgent with agent caller", () => {
      expect(getPriority({ tool: "runAgent", args: {}, caller: "agent" })).toBe(
        5,
      );
    });

    it("uses explicit priority when provided", () => {
      expect(getPriority({ tool: "test", args: {}, priority: 1 })).toBe(1);
    });
  });

  describe("enqueue", () => {
    it("returns the work result when job completes", async () => {
      const result = await enqueue(
        { tool: "test", args: { exec: async () => "done" }, priority: 3 },
        getCtx,
      );
      expect(result).toBe("done");
    });

    it("propagates errors from work", async () => {
      await expect(
        enqueue(
          {
            tool: "test",
            args: {
              exec: async () => {
                throw new Error("work failed");
              },
            },
            priority: 3,
          },
          getCtx,
        ),
      ).rejects.toThrow("work failed");
    });

    it("processes higher priority jobs first", async () => {
      const order: number[] = [];
      const p5 = enqueue(
        {
          tool: "test",
          args: {
            exec: async () => {
              order.push(5);
              return 5;
            },
          },
          priority: 5,
        },
        getCtx,
      );
      const p3 = enqueue(
        {
          tool: "test",
          args: {
            exec: async () => {
              order.push(3);
              return 3;
            },
          },
          priority: 3,
        },
        getCtx,
      );
      const p1 = enqueue(
        {
          tool: "test",
          args: {
            exec: async () => {
              order.push(1);
              return 1;
            },
          },
          priority: 1,
        },
        getCtx,
      );
      const p4 = enqueue(
        {
          tool: "test",
          args: {
            exec: async () => {
              order.push(4);
              return 4;
            },
          },
          priority: 4,
        },
        getCtx,
      );
      const p2 = enqueue(
        {
          tool: "test",
          args: {
            exec: async () => {
              order.push(2);
              return 2;
            },
          },
          priority: 2,
        },
        getCtx,
      );

      const results = await Promise.all([p1, p2, p3, p4, p5]);
      expect(results).toEqual([1, 2, 3, 4, 5]);
      expect(order).toEqual([1, 2, 3, 4, 5]);
    });

    it("executes registered agent tools via executeTool", async () => {
      const result = (await enqueue(
        {
          tool: "executeTool",
          args: {
            toolName: "cron_echo",
            toolArgs: { message: "hello from queue" },
            agentId: "maia",
            sessionId: "test-session",
          },
          caller: "maia",
        },
        getCtx,
      )) as string;
      expect(result).toBe("hello from queue");
    });

    it("processes same-priority jobs in FIFO order", async () => {
      const order: number[] = [];
      const p1 = enqueue(
        { tool: "test", args: { exec: async () => "trigger" }, priority: 1 },
        getCtx,
      );
      const p3a = enqueue(
        {
          tool: "test",
          args: {
            exec: async () => {
              order.push(1);
              return 1;
            },
          },
          priority: 3,
        },
        getCtx,
      );
      const p3b = enqueue(
        {
          tool: "test",
          args: {
            exec: async () => {
              order.push(2);
              return 2;
            },
          },
          priority: 3,
        },
        getCtx,
      );
      const p3c = enqueue(
        {
          tool: "test",
          args: {
            exec: async () => {
              order.push(3);
              return 3;
            },
          },
          priority: 3,
        },
        getCtx,
      );

      await Promise.all([p1, p3a, p3b, p3c]);
      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe("getQueueSnapshot", () => {
    it("returns empty array when queue is empty", () => {
      expect(getQueueSnapshot()).toEqual([]);
    });

    it("returns queued jobs with sanitized args (functions replaced)", async () => {
      void enqueue(
        {
          tool: "test",
          args: { exec: async () => new Promise((r) => setTimeout(r, 100)) },
          priority: 1,
        },
        getCtx,
      );
      void enqueue(
        { tool: "test", args: { x: 5, fn: () => {} }, priority: 2 },
        getCtx,
      );
      const snap = getQueueSnapshot();
      expect(snap.length).toBeGreaterThanOrEqual(1);
      const testJob = snap.find(
        (j) => j.args && "x" in j.args && j.args.x === 5,
      );
      expect(testJob).toBeDefined();
      expect(testJob?.tool).toBe("test");
      expect(testJob?.args).toEqual({ x: 5, fn: "[fn]" });
    });
  });

  describe("embedding-ready gate", () => {
    it("isEmbeddingReady returns false initially", () => {
      expect(isEmbeddingReady()).toBe(false);
    });

    it("isEmbeddingReady returns true after setEmbeddingReady", () => {
      setEmbeddingReady();
      expect(isEmbeddingReady()).toBe(true);
    });

    it("_resetEmbeddingReadyForTests resets to false", () => {
      setEmbeddingReady();
      _resetEmbeddingReadyForTests();
      expect(isEmbeddingReady()).toBe(false);
    });
  });

  describe("heartbeat", () => {
    it("processes queued jobs when heartbeat is running", async () => {
      startQueueProcessor(50);
      const result = await enqueue(
        {
          tool: "test",
          args: { exec: async () => "heartbeat-ok" },
          priority: 3,
        },
        getCtx,
      );
      expect(result).toBe("heartbeat-ok");
    });
  });

  describe("tickQueueProcessor", () => {
    it("triggers processing of pending jobs when called (request-driven tick)", async () => {
      _resetQueueForTests();
      registerLlmQueueHandlers();
      const resultPromise = enqueue(
        { tool: "test", args: { exec: async () => "tick-ok" }, priority: 3 },
        getCtx,
      );
      tickQueueProcessor();
      const result = await resultPromise;
      expect(result).toBe("tick-ok");
    });

    it("is no-op when queue is empty", () => {
      _resetQueueForTests();
      expect(() => tickQueueProcessor()).not.toThrow();
    });
  });

  describe("lazy handler registration", () => {
    it("registers handlers on first enqueue when not pre-registered (simulates fresh module instance)", async () => {
      _resetQueueForTests();
      // Do NOT call registerLlmQueueHandlers() - simulate a chunk that never ran instrumentation.
      const result = await enqueue(
        {
          tool: "test",
          args: { exec: async () => "lazy-init-ok" },
          priority: 3,
        },
        getCtx,
      );
      expect(result).toBe("lazy-init-ok");
    });

    it("processes job without interval when handlers are lazy-registered", async () => {
      _resetQueueForTests();
      // No startQueueProcessor, no registerLlmQueueHandlers - enqueue triggers both lazy init and sync heartbeat.
      const result = await enqueue(
        {
          tool: "test",
          args: { exec: async () => "no-interval-ok" },
          priority: 3,
        },
        getCtx,
      );
      expect(result).toBe("no-interval-ok");
    });
  });
});
