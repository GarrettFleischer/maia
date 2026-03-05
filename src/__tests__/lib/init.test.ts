/**
 * @fileoverview Tests for server initialization (initMaiaAgent).
 * @module __tests__/lib/init.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import path from "path";
import { makeTestContext, FakeFs } from "../helpers/fakes";
import { initMaiaAgent } from "@/lib/init";
import type { AppContext } from "@/lib/context";
import {
  getDefaultSkillsDir,
  getDefaultMaiaSkillsDir,
  getSkillsDir,
  getAgentSkillsDir,
} from "@/lib/data-dir";

describe("initMaiaAgent", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("inserts maia agent row on first call", () => {
    const before = ctx.db
      .prepare("SELECT id FROM agents WHERE id = 'maia'")
      .get();
    expect(before).toBeUndefined();

    initMaiaAgent(ctx);

    const row = ctx.db
      .prepare("SELECT id, name, model, status FROM agents WHERE id = 'maia'")
      .get() as {
      id: string;
      name: string;
      model: string;
      status: string;
    };
    expect(row).toBeDefined();
    expect(row.id).toBe("maia");
    expect(row.name).toBe("Maia");
    expect(row.model).toBe("ollama/llama3.2");
    expect(row.status).toBe("active");
  });

  it("is idempotent on second call", () => {
    initMaiaAgent(ctx);
    initMaiaAgent(ctx);

    const rows = ctx.db
      .prepare("SELECT id FROM agents WHERE id = 'maia'")
      .all() as { id: string }[];
    expect(rows).toHaveLength(1);
  });

  it("seeds default skills into skills dir when none exist", () => {
    const fs = new FakeFs();
    const ctxWithFs = makeTestContext({ fs });
    const defaultSkillsDir = getDefaultSkillsDir();
    const skillsDir = getSkillsDir();
    const defaultSkillPath = path.join(defaultSkillsDir, "memory-basics.md");
    const defaultContent = "---\nname: memory\n---\n\nBody\n";

    fs.seed(defaultSkillPath, defaultContent);
    expect(fs.exists(skillsDir)).toBe(false);

    initMaiaAgent(ctxWithFs);

    const snapshot = fs.snapshot();
    const copiedPath = path.join(skillsDir, "memory-basics.md");
    expect(snapshot[copiedPath]).toBe(defaultContent);
  });

  it("does not copy default skills when skills already exist", () => {
    const fs = new FakeFs();
    const ctxWithFs = makeTestContext({ fs });
    const defaultSkillsDir = getDefaultSkillsDir();
    const skillsDir = getSkillsDir();
    const defaultSkillPath = path.join(defaultSkillsDir, "memory-basics.md");
    const defaultContent = "---\nname: memory\n---\n\nBody\n";
    const existingSkillPath = path.join(skillsDir, "existing.md");
    const existingContent = "Existing skill";

    fs.seed(defaultSkillPath, defaultContent);
    fs.seed(existingSkillPath, existingContent);

    initMaiaAgent(ctxWithFs);

    const snapshot = fs.snapshot();
    expect(snapshot[existingSkillPath]).toBe(existingContent);
    expect(snapshot[path.join(skillsDir, "memory-basics.md")]).toBeUndefined();
  });

  it("seeds Maia skills from defaults/maia/skills when her skills dir is empty", () => {
    const fs = new FakeFs();
    const ctxWithFs = makeTestContext({ fs });
    const defaultMaiaSkillsDir = getDefaultMaiaSkillsDir();
    const maiaSkillsDir = getAgentSkillsDir("maia");
    const defaultSkillPath = path.join(
      defaultMaiaSkillsDir,
      "agent-creation-and-lifecycle.md",
    );
    const defaultContent =
      "---\nname: agent-creation-and-lifecycle\ndescription: Maia-only agent creation.\n---\n\n# Agent creation\n";

    fs.seed(defaultSkillPath, defaultContent);
    initMaiaAgent(ctxWithFs);

    const snapshot = fs.snapshot();
    const copiedPath = path.join(
      maiaSkillsDir,
      "agent-creation-and-lifecycle.md",
    );
    expect(snapshot[copiedPath]).toBe(defaultContent);
  });

  it("does not overwrite existing Maia skills when seeding", () => {
    const fs = new FakeFs();
    const ctxWithFs = makeTestContext({ fs });
    const defaultMaiaSkillsDir = getDefaultMaiaSkillsDir();
    const maiaSkillsDir = getAgentSkillsDir("maia");
    const defaultSkillPath = path.join(
      defaultMaiaSkillsDir,
      "agent-creation-and-lifecycle.md",
    );
    const existingSkillPath = path.join(maiaSkillsDir, "custom.md");
    const existingContent = "Custom Maia skill";

    fs.seed(defaultSkillPath, "---\nname: x\n---\n\nDefault");
    fs.mkdirp(maiaSkillsDir);
    fs.seed(existingSkillPath, existingContent);

    initMaiaAgent(ctxWithFs);

    const snapshot = fs.snapshot();
    expect(snapshot[existingSkillPath]).toBe(existingContent);
    expect(
      snapshot[path.join(maiaSkillsDir, "agent-creation-and-lifecycle.md")],
    ).toBeUndefined();
  });
});
