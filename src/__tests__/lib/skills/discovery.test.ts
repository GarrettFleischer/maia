/**
 * @fileoverview Tests for skill discovery: listSkillFiles, loadSkillMetadata, loadSkillContent, getAvailableSkillsMetadata.
 * @module __tests__/lib/skills/discovery
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "path";
import os from "os";
import fs from "fs";
import type { FileSystemAdapter } from "@/lib/context";
import {
  listSkillFiles,
  loadSkillMetadata,
  loadSkillContent,
  getAvailableSkillsMetadata,
} from "@/lib/skills";
import { getSkillsDir, getAgentSkillsDir } from "@/lib/data-dir";

describe("listSkillFiles", () => {
  it("returns only .md files in directory", () => {
    const mockFs: FileSystemAdapter = {
      listDir: (dir) => {
        if (dir.endsWith("skills")) return ["a.md", "b.md", "readme.txt", "other.md"];
        return [];
      },
    } as FileSystemAdapter;
    const dir = "/some/skills";
    expect(listSkillFiles(mockFs, dir)).toEqual(["a.md", "b.md", "other.md"]);
  });

  it("returns empty array when directory is empty", () => {
    const mockFs: FileSystemAdapter = {
      listDir: () => [],
    } as FileSystemAdapter;
    expect(listSkillFiles(mockFs, "/empty")).toEqual([]);
  });
});

describe("loadSkillMetadata", () => {
  it("returns metadata when file has valid frontmatter", () => {
    const content = `---
name: my-skill
description: Does something useful.
---

# Body
`;
    const mockFs: FileSystemAdapter = {
      readFile: () => content,
    } as FileSystemAdapter;
    const result = loadSkillMetadata(mockFs, "/path/to/skill.md");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("my-skill");
    expect(result!.description).toBe("Does something useful.");
    expect(result!.sourcePath).toBe("/path/to/skill.md");
  });

  it("returns null when file has invalid frontmatter", () => {
    const mockFs: FileSystemAdapter = {
      readFile: () => "no frontmatter",
    } as FileSystemAdapter;
    expect(loadSkillMetadata(mockFs, "/path/to/bad.md")).toBeNull();
  });
});

describe("loadSkillContent", () => {
  it("returns full skill with content when file is valid", () => {
    const content = `---
name: full-skill
description: Full content test.
---

# Instructions
Do this and that.
`;
    const mockFs: FileSystemAdapter = {
      readFile: () => content,
    } as FileSystemAdapter;
    const result = loadSkillContent(mockFs, "/path/to/full.md");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("full-skill");
    expect(result!.description).toBe("Full content test.");
    expect(result!.sourcePath).toBe("/path/to/full.md");
    expect(result!.content).toContain("# Instructions");
    expect(result!.content).toContain("Do this and that.");
  });

  it("returns null when frontmatter is invalid", () => {
    const mockFs: FileSystemAdapter = {
      readFile: () => "invalid",
    } as FileSystemAdapter;
    expect(loadSkillContent(mockFs, "/bad.md")).toBeNull();
  });
});

describe("getAvailableSkillsMetadata", () => {
  let tmpDir: string;
  let origMaiaDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `maia-skills-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, "skills"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "agents", "maia", "skills"), { recursive: true });
    origMaiaDataDir = process.env.MAIA_DATA_DIR;
    process.env.MAIA_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origMaiaDataDir !== undefined) {
      process.env.MAIA_DATA_DIR = origMaiaDataDir;
    } else {
      delete process.env.MAIA_DATA_DIR;
    }
  });

  it("returns empty array when no skill files exist", () => {
    const ctx = { fs: makeNodeFs() } as import("@/lib/context").AppContext;
    const result = getAvailableSkillsMetadata(ctx, "maia");
    expect(result).toEqual([]);
  });

  it("returns global and agent skills combined", () => {
    const globalSkill = `---
name: global-skill
description: Global skill for all agents.
---

Global body
`;
    const agentSkill = `---
name: agent-skill
description: Only for this agent.
---

Agent body
`;
    fs.writeFileSync(path.join(getSkillsDir(), "global-skill.md"), globalSkill);
    fs.writeFileSync(path.join(getAgentSkillsDir("maia"), "agent-skill.md"), agentSkill);

    const ctx = { fs: makeNodeFs() } as import("@/lib/context").AppContext;
    const result = getAvailableSkillsMetadata(ctx, "maia");
    expect(result.length).toBe(2);
    const names = result.map((s) => s.name).sort();
    expect(names).toEqual(["agent-skill", "global-skill"]);
    const global = result.find((s) => s.name === "global-skill");
    const agent = result.find((s) => s.name === "agent-skill");
    expect(global!.sourcePath).toContain("skills");
    expect(global!.sourcePath).toContain("global-skill.md");
    expect(agent!.sourcePath).toContain("maia");
    expect(agent!.sourcePath).toContain("agent-skill.md");
  });

  it("does not throw when skills dir does not exist", () => {
    process.env.MAIA_DATA_DIR = path.join(os.tmpdir(), `maia-none-${Date.now()}`);
    const ctx = { fs: makeNodeFs() } as import("@/lib/context").AppContext;
    expect(() => getAvailableSkillsMetadata(ctx, "maia")).not.toThrow();
    const result = getAvailableSkillsMetadata(ctx, "maia");
    expect(result).toEqual([]);
  });
});

function makeNodeFs(): FileSystemAdapter {
  return {
    readFile: (p: string) => fs.readFileSync(p, "utf8"),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf8"),
    appendFile: () => {},
    deleteFile: (p: string) => fs.rmSync(p, { force: true }),
    listDir: (p: string) => fs.readdirSync(p),
    rename: (f: string, t: string) => fs.renameSync(f, t),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
  };
}
