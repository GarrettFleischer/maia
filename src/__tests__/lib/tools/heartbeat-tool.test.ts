/**
 * @fileoverview Tests for the internal heartbeat tool.
 * Verifies behavior when Maia is missing and when embedding refresh fails.
 * @module __tests__/lib/tools/heartbeat-tool
 */

import { describe, it, expect, spyOn } from "bun:test";
import { createHeartbeatTool } from "@/lib/tools/heartbeat-tool";
import type { AppContext } from "@/lib/context";
import { makeTestContext, FakeEvents } from "@/__tests__/helpers/fakes";
import * as queue from "@/lib/queue/llm-queue";
import * as dataBackup from "@/lib/data-backup";
import * as agentIdentity from "@/lib/agent/identity";

describe("heartbeat-tool", () => {
  function makeCtx(): AppContext {
    const events = new FakeEvents();
    const ctx = makeTestContext({ events });
    return ctx;
  }

  it("emits heartbeat event and runs data backup when Maia is missing", async () => {
    const ctx = makeCtx();
    const events = ctx.events as FakeEvents;
    const runAgentFn = async () => {};
    const enqueueSpy = spyOn(queue, "enqueue");
    enqueueSpy.mockImplementation(async () => {
      // no-op for this test
    });
    const backupSpy = spyOn(dataBackup, "runDataBackup").mockResolvedValue();
    const identitySpy = spyOn(
      agentIdentity,
      "getAgentIdentity",
    ).mockReturnValue(null);

    const tool = createHeartbeatTool(runAgentFn);
    const result = (await tool.execute({}, ctx as never)) as {
      woken: number;
      timestamp: string;
    };

    expect(result.woken).toBe(0);
    expect(typeof result.timestamp).toBe("string");
    expect(events.emitted.some((e) => e.event === "heartbeat")).toBeTruthy();
    expect(backupSpy).toHaveBeenCalled();
    expect(enqueueSpy).toHaveBeenCalledWith(
      { tool: "refreshEmbeddings", args: {}, caller: "system" },
      expect.any(Function),
    );

    enqueueSpy.mockRestore();
    backupSpy.mockRestore();
    identitySpy.mockRestore();
  });
});
