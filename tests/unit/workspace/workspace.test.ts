/**
 * @fileoverview Unit tests for workspace file loading, templates, and bootstrap.
 * @module tests/unit/workspace/workspace
 */

import { describe, it, expect } from "bun:test";
import { createWorkspaceLoader } from "../../../src/workspace/loader.js";
import { createBootstrap } from "../../../src/workspace/bootstrap.js";
import { createTestContext, inMemoryFileSystem } from "../../helpers/index.js";

describe("Workspace Loader", () => {
  it("should load SOUL.md from workspace", async () => {
    const fs = inMemoryFileSystem({
      "/workspace/SOUL.md": "# Soul\nI am Maia.",
    });
    const ctx = createTestContext({ fs });
    const loader = createWorkspaceLoader(ctx, "/workspace");

    const soul = await loader.loadSoul();
    expect(soul).toContain("I am Maia");
  });

  it("should load AGENTS.md from workspace", async () => {
    const fs = inMemoryFileSystem({
      "/workspace/AGENTS.md": "# Agents\nFollow these rules.",
    });
    const ctx = createTestContext({ fs });
    const loader = createWorkspaceLoader(ctx, "/workspace");

    const agents = await loader.loadAgents();
    expect(agents).toContain("Follow these rules");
  });

  it("should load USER.md from workspace", async () => {
    const fs = inMemoryFileSystem({
      "/workspace/USER.md": "# User\nName: Test User",
    });
    const ctx = createTestContext({ fs });
    const loader = createWorkspaceLoader(ctx, "/workspace");

    const user = await loader.loadUser();
    expect(user).toContain("Test User");
  });

  it("should load IDENTITY.md from workspace", async () => {
    const fs = inMemoryFileSystem({
      "/workspace/IDENTITY.md": "name: Maia\nemoji: 🌙",
    });
    const ctx = createTestContext({ fs });
    const loader = createWorkspaceLoader(ctx, "/workspace");

    const identity = await loader.loadIdentity();
    expect(identity).toContain("Maia");
  });

  it("should load MEMORY.md from workspace", async () => {
    const fs = inMemoryFileSystem({
      "/workspace/MEMORY.md": "# Memory\nUser prefers dark mode.",
    });
    const ctx = createTestContext({ fs });
    const loader = createWorkspaceLoader(ctx, "/workspace");

    const memory = await loader.loadMemory();
    expect(memory).toContain("dark mode");
  });

  it("should return empty string for missing files", async () => {
    const fs = inMemoryFileSystem();
    const ctx = createTestContext({ fs });
    const loader = createWorkspaceLoader(ctx, "/workspace");

    const soul = await loader.loadSoul();
    expect(soul).toBe("");
  });

  it("should load all workspace files at once", async () => {
    const fs = inMemoryFileSystem({
      "/workspace/SOUL.md": "soul content",
      "/workspace/AGENTS.md": "agents content",
      "/workspace/USER.md": "user content",
      "/workspace/IDENTITY.md": "identity content",
      "/workspace/TOOLS.md": "tools content",
      "/workspace/MEMORY.md": "memory content",
    });
    const ctx = createTestContext({ fs });
    const loader = createWorkspaceLoader(ctx, "/workspace");

    const all = await loader.loadAll();
    expect(all.soul).toBe("soul content");
    expect(all.agents).toBe("agents content");
    expect(all.user).toBe("user content");
    expect(all.identity).toBe("identity content");
    expect(all.tools).toBe("tools content");
    expect(all.memory).toBe("memory content");
  });
});

describe("Bootstrap", () => {
  it("should detect when bootstrap is needed", async () => {
    const fs = inMemoryFileSystem({
      "/workspace/BOOTSTRAP.md": "# Bootstrap\nWelcome!",
    });
    const ctx = createTestContext({ fs });
    const bootstrap = createBootstrap(ctx, "/workspace");

    expect(await bootstrap.isNeeded()).toBe(true);
  });

  it("should not need bootstrap if BOOTSTRAP.md is missing", async () => {
    const fs = inMemoryFileSystem();
    const ctx = createTestContext({ fs });
    const bootstrap = createBootstrap(ctx, "/workspace");

    expect(await bootstrap.isNeeded()).toBe(false);
  });

  it("should create default workspace files from templates", async () => {
    const fs = inMemoryFileSystem();
    const ctx = createTestContext({ fs });
    const bootstrap = createBootstrap(ctx, "/workspace");

    await bootstrap.initializeWorkspace();

    expect(await fs.exists("/workspace/SOUL.md")).toBe(true);
    expect(await fs.exists("/workspace/AGENTS.md")).toBe(true);
    expect(await fs.exists("/workspace/USER.md")).toBe(true);
    expect(await fs.exists("/workspace/IDENTITY.md")).toBe(true);
    expect(await fs.exists("/workspace/TOOLS.md")).toBe(true);
    expect(await fs.exists("/workspace/BOOTSTRAP.md")).toBe(true);
  });

  it("should mark bootstrap as complete by removing BOOTSTRAP.md", async () => {
    const fs = inMemoryFileSystem({
      "/workspace/BOOTSTRAP.md": "# Bootstrap",
    });
    const ctx = createTestContext({ fs });
    const bootstrap = createBootstrap(ctx, "/workspace");

    await bootstrap.complete();
    expect(await fs.exists("/workspace/BOOTSTRAP.md")).toBe(false);
  });
});
