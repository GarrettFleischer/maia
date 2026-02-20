/**
 * @fileoverview Tests for heartbeat interval: startHeartbeatInterval invokes runner and stop clears the interval.
 * @module tests/heartbeat/interval.test
 */

import { describe, expect, it } from "bun:test";
import type { AgentForHeartbeat, RunHeartbeatOnceDeps } from "@/heartbeat/runner";
import { startHeartbeatInterval, startHeartbeatIntervalWithFactory } from "@/heartbeat/interval";

describe("heartbeat interval", () => {
  it("invokes runHeartbeatOnce on the interval", async () => {
    let runCount = 0;
    const deps: RunHeartbeatOnceDeps = {
      sandboxRoot: "/tmp",
      listEnabledAgents: async () => [{ id: "agent-1", enabled: 1 }],
      runAgentTurn: async () => {
        runCount++;
      },
    };
    const intervalMs = 30;
    const { stop } = startHeartbeatInterval(deps, intervalMs);

    await new Promise((r) => setTimeout(r, 80));
    expect(runCount).toBeGreaterThanOrEqual(1);
    stop();
    const afterStop = runCount;
    await new Promise((r) => setTimeout(r, 50));
    expect(runCount).toBe(afterStop);
  });

  it("stop() clears the interval so runner is not called after stop", async () => {
    let runCount = 0;
    const deps: RunHeartbeatOnceDeps = {
      sandboxRoot: "/tmp",
      listEnabledAgents: async () => [{ id: "agent-1", enabled: 1 }],
      runAgentTurn: async () => {
        runCount++;
      },
    };
    const intervalMs = 100;
    const { stop } = startHeartbeatInterval(deps, intervalMs);
    stop();
    await new Promise((r) => setTimeout(r, 150));
    expect(runCount).toBe(0);
  });

  it("does not start next tick until previous tick and close have finished (serialized)", async () => {
    const events: Array<"tickStart" | "tickEnd"> = [];
    const tickDurationMs = 80;
    const intervalMs = 30;
    const getDeps = async (): Promise<{
      deps: RunHeartbeatOnceDeps;
      close?: () => void;
    }> => {
      events.push("tickStart");
      return {
        deps: {
          sandboxRoot: "/tmp",
          listEnabledAgents: async () => [{ id: "agent-1", enabled: 1 }],
          runAgentTurn: async () => {
            await new Promise((r) => setTimeout(r, tickDurationMs));
          },
        },
        close: () => {
          events.push("tickEnd");
        },
      };
    };
    const { stop } = startHeartbeatIntervalWithFactory(getDeps, intervalMs);
    await new Promise((r) => setTimeout(r, 250));
    stop();
    for (let i = 0; i < events.length - 1; i++) {
      expect([events[i], events[i + 1]]).not.toEqual(["tickStart", "tickStart"]);
    }
    expect(events.filter((e) => e === "tickStart").length).toBeGreaterThanOrEqual(2);
  });

  it("uses fresh deps each tick so newly added agents are seen", async () => {
    const agentsPerTick: AgentForHeartbeat[][] = [[], [{ id: "new-agent", enabled: 1 }]];
    let tickIndex = 0;
    const runAgentIds: string[] = [];
    const getDeps = async (): Promise<{
      deps: RunHeartbeatOnceDeps;
      close?: () => void;
    }> => {
      const list = agentsPerTick[Math.min(tickIndex++, agentsPerTick.length - 1)] ?? [];
      return {
        deps: {
          sandboxRoot: "/tmp",
          listEnabledAgents: async () => list,
          runAgentTurn: async (agentId: string) => {
            runAgentIds.push(agentId);
          },
        },
      };
    };
    const intervalMs = 30;
    const { stop } = startHeartbeatIntervalWithFactory(getDeps, intervalMs);
    await new Promise((r) => setTimeout(r, 100));
    stop();
    expect(runAgentIds).toContain("new-agent");
  });
});
