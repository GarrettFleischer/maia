/**
 * @fileoverview Integration tests for heartbeat runner (loads .md context, runs only enabled agents).
 * @module tests/heartbeat/runner.test
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { openDb } from "@/db/client";
import { createAgentRepository } from "@/db/agents";
import { runHeartbeatOnce } from "@/heartbeat/runner";

describe("heartbeat runner", () => {
  it("loads all .md files and calls runAgentTurn for enabled agent", async () => {
    const db = await openDb(":memory:");
    const tmpDir = path.join(process.cwd(), "tmp-heartbeat-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const agentRepo = createAgentRepository(db, tmpDir, {
      mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    });
    const agent = await agentRepo.create({
      name: "Test",
      purpose: "Test purpose",
    });
    const soulPath = path.join(tmpDir, agent.id, "SOUL.md");
    fs.writeFileSync(soulPath, "# Soul\n\nI am helpful.", "utf-8");
    const heartbeatPath = path.join(tmpDir, agent.id, "HEARTBEAT.md");
    fs.writeFileSync(heartbeatPath, "# Goals\n\n- Do something", "utf-8");

    const turns: { agentId: string; context: Record<string, string> }[] = [];
    await runHeartbeatOnce({
      sandboxRoot: tmpDir,
      listEnabledAgents: async () => [agent as { id: string; enabled: number }],
      runAgentTurn: async (agentId, context) => {
        turns.push({ agentId, context });
      },
    });

    expect(turns.length).toBe(1);
    expect(turns[0].agentId).toBe(agent.id);
    expect(turns[0].context["IDENTITY.md"]).toBeDefined();
    expect(turns[0].context["SOUL.md"]).toContain("I am helpful");
    expect(turns[0].context["HEARTBEAT.md"]).toContain("Do something");
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips disabled agents", async () => {
    const db = await openDb(":memory:");
    const tmpDir = path.join(process.cwd(), "tmp-heartbeat2-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const agentRepo = createAgentRepository(db, tmpDir, {
      mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    });
    const agent = await agentRepo.create({ name: "Disabled", purpose: "X" });
    await agentRepo.update(agent.id, { enabled: 0 });

    const turns: string[] = [];
    await runHeartbeatOnce({
      sandboxRoot: tmpDir,
      listEnabledAgents: async () =>
        (await agentRepo.list()).filter((a) => a.enabled === 1),
      runAgentTurn: async (agentId) => {
        turns.push(agentId);
      },
    });

    expect(turns.length).toBe(0);
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
