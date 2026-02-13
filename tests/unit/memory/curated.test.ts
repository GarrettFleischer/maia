/**
 * @fileoverview Unit tests for Tier 2 MEMORY.md read/update helpers.
 * @module tests/unit/memory/curated
 */

import { describe, it, expect } from "bun:test";
import { createCuratedMemory } from "../../../src/memory/curated.js";
import { inMemoryFileSystem } from "../../helpers/index.js";

describe("Curated Memory (MEMORY.md)", () => {
  function makeCurated() {
    const fs = inMemoryFileSystem();
    const curated = createCuratedMemory({ fs, memoryPath: "/workspace/MEMORY.md" });
    return { curated, fs };
  }

  it("should read MEMORY.md content", async () => {
    const { curated, fs } = makeCurated();
    await fs.writeFile("/workspace/MEMORY.md", "# Memory\nUser likes TypeScript.");

    const content = await curated.read();
    expect(content).toContain("TypeScript");
  });

  it("should return empty string if MEMORY.md does not exist", async () => {
    const { curated } = makeCurated();
    const content = await curated.read();
    expect(content).toBe("");
  });

  it("should write new content to MEMORY.md", async () => {
    const { curated, fs } = makeCurated();
    await curated.write("# Memory\nNew content here.");

    const content = await fs.readFile("/workspace/MEMORY.md");
    expect(content).toContain("New content here");
  });

  it("should overwrite existing content", async () => {
    const { curated, fs } = makeCurated();
    await fs.writeFile("/workspace/MEMORY.md", "Old content");
    await curated.write("New content");

    const content = await fs.readFile("/workspace/MEMORY.md");
    expect(content).toBe("New content");
    expect(content).not.toContain("Old content");
  });

  it("should append a section to MEMORY.md", async () => {
    const { curated, fs } = makeCurated();
    await fs.writeFile("/workspace/MEMORY.md", "# Memory\nExisting.");
    await curated.appendSection("## New Section\nNew info.");

    const content = await fs.readFile("/workspace/MEMORY.md");
    expect(content).toContain("Existing.");
    expect(content).toContain("## New Section");
    expect(content).toContain("New info.");
  });
});
