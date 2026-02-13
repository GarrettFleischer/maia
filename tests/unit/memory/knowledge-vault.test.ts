/**
 * @fileoverview Unit tests for the Obsidian knowledge vault (Tier 4).
 * @module tests/unit/memory/knowledge-vault
 */

import { describe, it, expect } from "bun:test";
import { createKnowledgeVault } from "../../../src/knowledge/vault.js";
import { createWikilinkParser } from "../../../src/knowledge/linker.js";
import { inMemoryFileSystem, capturingLogger } from "../../helpers/index.js";

describe("Knowledge Vault", () => {
  function makeVault() {
    const fs = inMemoryFileSystem();
    const logger = capturingLogger();
    const vault = createKnowledgeVault({
      fs,
      logger,
      basePath: "/workspace/knowledge",
    });
    return { vault, fs };
  }

  it("should create a note with frontmatter", async () => {
    const { vault, fs } = makeVault();
    await vault.createNote({
      path: "people/John Smith.md",
      title: "John Smith",
      content: "Backend developer on the [[Maia Project]].",
      frontmatter: {
        tags: ["person", "colleague"],
        created: "2026-02-13",
        updated: "2026-02-13",
      },
      wikilinks: ["Maia Project"],
    });

    const content = await fs.readFile("/workspace/knowledge/people/John Smith.md");
    expect(content).toContain("# John Smith");
    expect(content).toContain("tags:");
    expect(content).toContain("[[Maia Project]]");
  });

  it("should update an existing note", async () => {
    const { vault, fs } = makeVault();
    await fs.writeFile(
      "/workspace/knowledge/people/John.md",
      "---\ntags: [person]\ncreated: 2026-02-10\nupdated: 2026-02-10\n---\n\n# John\nOld content."
    );

    await vault.updateNote("people/John.md", {
      content: "# John\nUpdated content.",
      frontmatter: { updated: "2026-02-13" },
    });

    const content = await fs.readFile("/workspace/knowledge/people/John.md");
    expect(content).toContain("Updated content");
    expect(content).toContain("2026-02-13");
  });

  it("should list notes in a category", async () => {
    const { vault, fs } = makeVault();
    await fs.writeFile("/workspace/knowledge/people/Alice.md", "# Alice");
    await fs.writeFile("/workspace/knowledge/people/Bob.md", "# Bob");

    const notes = await vault.listNotes("people");
    expect(notes).toContain("Alice.md");
    expect(notes).toContain("Bob.md");
  });

  it("should check if a note exists", async () => {
    const { vault, fs } = makeVault();
    await fs.writeFile("/workspace/knowledge/topics/TypeScript.md", "# TypeScript");

    expect(await vault.noteExists("topics/TypeScript.md")).toBe(true);
    expect(await vault.noteExists("topics/Nonexistent.md")).toBe(false);
  });

  it("should read a note", async () => {
    const { vault, fs } = makeVault();
    await fs.writeFile(
      "/workspace/knowledge/projects/Maia.md",
      "---\ntags: [project]\ncreated: 2026-02-13\nupdated: 2026-02-13\n---\n\n# Maia\nAI assistant project."
    );

    const note = await vault.readNote("projects/Maia.md");
    expect(note.title).toBe("Maia");
    expect(note.content).toContain("AI assistant");
  });
});

describe("Wikilink Parser", () => {
  it("should extract [[wikilinks]] from content", () => {
    const parser = createWikilinkParser();
    const links = parser.extract("Check [[Maia Project]] and [[TypeScript Patterns]].");
    expect(links).toContain("Maia Project");
    expect(links).toContain("TypeScript Patterns");
  });

  it("should handle aliased links", () => {
    const parser = createWikilinkParser();
    const links = parser.extract("Uses [[TypeScript Patterns|TypeScript]].");
    expect(links).toContain("TypeScript Patterns");
  });

  it("should return empty array for no links", () => {
    const parser = createWikilinkParser();
    const links = parser.extract("No links here.");
    expect(links).toEqual([]);
  });

  it("should deduplicate links", () => {
    const parser = createWikilinkParser();
    const links = parser.extract("[[Maia]] and [[Maia]] again.");
    expect(links).toEqual(["Maia"]);
  });

  it("should handle empty content", () => {
    const parser = createWikilinkParser();
    const links = parser.extract("");
    expect(links).toEqual([]);
  });
});
