/**
 * @fileoverview Integration tests for agent repository (CRUD, all .md files, workspace on create).
 * @module tests/db/agents.test
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { AGENT_MD_FILES, DEFAULT_MD_CONTENT } from "@/agent/context-files";
import { openDb } from "@/db/client";
import { createAgentRepository, MAIA_AGENT_ID } from "@/db/agents";

describe("agent repository", () => {
  it("create writes agent row, all five .md files with defaults, and workspace dir", async () => {
    const db = await openDb(":memory:");
    const tmpDir = path.join(process.cwd(), "tmp-agent-test-" + Date.now());
    const mkdir = (p: string) => fs.mkdirSync(p, { recursive: true });
    const writeFile = (p: string, content: string) =>
      fs.writeFileSync(p, content, "utf-8");
    const repo = createAgentRepository(db, tmpDir, { mkdir, writeFile });
    const agent = await repo.create({
      name: "Helper",
      purpose: "Help the user with tasks",
      model: "llama3.2",
    });
    expect(agent.id).toBeDefined();
    expect(agent.name).toBe("Helper");
    expect(agent.model).toBe("llama3.2");
    expect(agent.enabled).toBe(1);
    const agentDir = path.join(tmpDir, agent.id);
    for (const name of AGENT_MD_FILES) {
      const full = path.join(agentDir, name);
      expect(fs.existsSync(full)).toBe(true);
      const content = fs.readFileSync(full, "utf-8");
      if (name === "IDENTITY.md") {
        expect(content).toContain("Help the user with tasks");
      } else {
        expect(content).toBe(DEFAULT_MD_CONTENT[name as keyof typeof DEFAULT_MD_CONTENT]);
      }
    }
    const workspacePath = path.join(agentDir, "workspace");
    expect(fs.existsSync(workspacePath)).toBe(true);
    expect(fs.statSync(workspacePath).isDirectory()).toBe(true);
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("get returns agent by id", async () => {
    const db = await openDb(":memory:");
    const tmpDir = path.join(process.cwd(), "tmp-agent-test-" + Date.now());
    const repo = createAgentRepository(db, tmpDir, {
      mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    });
    const created = await repo.create({
      name: "Test",
      purpose: "Test agent",
    });
    const found = await repo.get(created.id);
    expect(found).not.toBeNull();
    expect(found?.name).toBe("Test");
    expect(found?.model).toBeNull();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("list returns all agents", async () => {
    const db = await openDb(":memory:");
    const tmpDir = path.join(process.cwd(), "tmp-agent-test-" + Date.now());
    const repo = createAgentRepository(db, tmpDir, {
      mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    });
    await repo.create({ name: "A", purpose: "A" });
    await repo.create({ name: "B", purpose: "B" });
    const list = await repo.list();
    expect(list.length).toBe(2);
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("update changes agent fields", async () => {
    const db = await openDb(":memory:");
    const tmpDir = path.join(process.cwd(), "tmp-agent-test-" + Date.now());
    const repo = createAgentRepository(db, tmpDir, {
      mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    });
    const created = await repo.create({ name: "X", purpose: "X" });
    await repo.update(created.id, { name: "Y", model: "llama3.2" });
    const found = await repo.get(created.id);
    expect(found?.name).toBe("Y");
    expect(found?.model).toBe("llama3.2");
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("create with optional id uses that id and creates workspace and all default .md files", async () => {
    const db = await openDb(":memory:");
    const tmpDir = path.join(process.cwd(), "tmp-agent-test-" + Date.now());
    const repo = createAgentRepository(db, tmpDir, {
      mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    });
    const agent = await repo.create({
      id: MAIA_AGENT_ID,
      name: "Maia",
      purpose: "Main assistant",
    });
    expect(agent.id).toBe(MAIA_AGENT_ID);
    expect(agent.name).toBe("Maia");
    const found = await repo.get(MAIA_AGENT_ID);
    expect(found).not.toBeNull();
    const agentDir = path.join(tmpDir, agent.id);
    for (const name of AGENT_MD_FILES) {
      expect(fs.existsSync(path.join(agentDir, name))).toBe(true);
    }
    expect(fs.existsSync(path.join(agentDir, "workspace"))).toBe(true);
    expect(fs.readFileSync(path.join(agentDir, "IDENTITY.md"), "utf-8")).toContain("Main assistant");
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("delete removes agent row", async () => {
    const db = await openDb(":memory:");
    const tmpDir = path.join(process.cwd(), "tmp-agent-test-" + Date.now());
    const repo = createAgentRepository(db, tmpDir, {
      mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    });
    const created = await repo.create({ name: "Del", purpose: "Del" });
    await repo.delete(created.id);
    const found = await repo.get(created.id);
    expect(found).toBeNull();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
