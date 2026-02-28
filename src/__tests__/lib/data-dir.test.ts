/**
 * @fileoverview Tests for data directory helpers: getDataDir, getAgentDir, getAgentWorkspace, getUserDir.
 * @module __tests__/lib/data-dir
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "path";
import fs from "fs";
import os from "os";
import {
  getDataDir,
  getAgentsDir,
  getAgentDir,
  getAgentWorkspace,
  getUserDir,
  getKnowledgeDir,
  getToolsDir,
  getSkillsDir,
  getAgentSkillsDir,
} from "@/lib/data-dir";

describe("data-dir", () => {
  let origMaiaDataDir: string | undefined;

  beforeEach(() => {
    origMaiaDataDir = process.env.MAIA_DATA_DIR;
  });

  afterEach(() => {
    if (origMaiaDataDir !== undefined) {
      process.env.MAIA_DATA_DIR = origMaiaDataDir;
    } else {
      delete process.env.MAIA_DATA_DIR;
    }
  });

  it("getDataDir returns MAIA_DATA_DIR when set", () => {
    const tmp = path.join(os.tmpdir(), `maia-data-${Date.now()}`);
    process.env.MAIA_DATA_DIR = tmp;
    expect(getDataDir()).toBe(path.resolve(tmp));
  });

  it("getAgentDir returns data/agents/<agentId> under data dir", () => {
    const tmp = path.join(os.tmpdir(), `maia-data-${Date.now()}`);
    process.env.MAIA_DATA_DIR = tmp;
    expect(getAgentDir("maia")).toBe(path.join(path.resolve(tmp), "agents", "maia"));
    expect(getAgentDir("agent-1")).toBe(path.join(path.resolve(tmp), "agents", "agent-1"));
  });

  it("getAgentWorkspace returns data/agents/<agentId>/workspace", () => {
    const tmp = path.join(os.tmpdir(), `maia-data-${Date.now()}`);
    process.env.MAIA_DATA_DIR = tmp;
    expect(getAgentWorkspace("maia")).toBe(path.join(path.resolve(tmp), "agents", "maia", "workspace"));
  });

  it("getUserDir returns data/user under data dir", () => {
    const tmp = path.join(os.tmpdir(), `maia-data-${Date.now()}`);
    process.env.MAIA_DATA_DIR = tmp;
    expect(getUserDir()).toBe(path.join(path.resolve(tmp), "user"));
  });

  it("getAgentsDir returns data/agents", () => {
    const tmp = path.join(os.tmpdir(), `maia-data-${Date.now()}`);
    process.env.MAIA_DATA_DIR = tmp;
    expect(getAgentsDir()).toBe(path.join(path.resolve(tmp), "agents"));
  });

  it("getAgentWorkspace is inside getAgentDir", () => {
    process.env.MAIA_DATA_DIR = path.join(os.tmpdir(), `maia-data-${Date.now()}`);
    const agentDir = getAgentDir("x");
    const workspace = getAgentWorkspace("x");
    expect(workspace).toBe(path.join(agentDir, "workspace"));
  });

  it("getKnowledgeDir returns data/knowledge (legacy)", () => {
    const tmp = path.join(os.tmpdir(), `maia-data-${Date.now()}`);
    process.env.MAIA_DATA_DIR = tmp;
    expect(getKnowledgeDir()).toBe(path.join(path.resolve(tmp), "knowledge"));
  });

  it("getToolsDir returns data/tools", () => {
    const tmp = path.join(os.tmpdir(), `maia-data-${Date.now()}`);
    process.env.MAIA_DATA_DIR = tmp;
    expect(getToolsDir()).toBe(path.join(path.resolve(tmp), "tools"));
  });

  it("getSkillsDir returns data/skills under data dir", () => {
    const tmp = path.join(os.tmpdir(), `maia-data-${Date.now()}`);
    process.env.MAIA_DATA_DIR = tmp;
    expect(getSkillsDir()).toBe(path.join(path.resolve(tmp), "skills"));
  });

  it("getAgentSkillsDir returns data/agents/<id>/skills", () => {
    const tmp = path.join(os.tmpdir(), `maia-data-${Date.now()}`);
    process.env.MAIA_DATA_DIR = tmp;
    expect(getAgentSkillsDir("maia")).toBe(path.join(path.resolve(tmp), "agents", "maia", "skills"));
    expect(getAgentSkillsDir("agent-1")).toBe(path.join(path.resolve(tmp), "agents", "agent-1", "skills"));
  });
});
