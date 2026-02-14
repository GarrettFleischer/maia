/**
 * @fileoverview Unit tests for knowledge note helpers.
 * @module tests/unit/knowledge/note
 */

import { describe, it, expect } from "bun:test";
import {
  createNote,
  extractWikilinks,
  serializeFrontmatter,
  parseFrontmatter,
  serializeNote,
} from "../../../src/knowledge/note.js";

describe("createNote", () => {
  it("should create note with required path and title", () => {
    const note = createNote({ path: "people/alice.md", title: "Alice" });
    expect(note.path).toBe("people/alice.md");
    expect(note.title).toBe("Alice");
    expect(note.content).toBe("");
    expect(note.frontmatter.tags).toEqual([]);
    expect(note.wikilinks).toEqual([]);
  });

  it("should include content and tags", () => {
    const note = createNote({
      path: "p/bob.md",
      title: "Bob",
      content: "See [[Alice]].",
      tags: ["person"],
      category: "people",
    });
    expect(note.content).toBe("See [[Alice]].");
    expect(note.frontmatter.tags).toEqual(["person"]);
    expect(note.frontmatter.category).toBe("people");
    expect(note.wikilinks).toContain("Alice");
  });
});

describe("extractWikilinks", () => {
  it("should return empty array for empty content", () => {
    expect(extractWikilinks("")).toEqual([]);
  });

  it("should extract simple wikilinks", () => {
    expect(extractWikilinks("See [[Alice]] and [[Bob]].")).toEqual(["Alice", "Bob"]);
  });

  it("should handle aliased links", () => {
    expect(extractWikilinks("[[Bob|Robert]]")).toEqual(["Bob"]);
  });

  it("should deduplicate", () => {
    expect(extractWikilinks("[[A]] and [[A]]")).toEqual(["A"]);
  });
});

describe("serializeFrontmatter", () => {
  it("should produce YAML with --- delimiters", () => {
    const fm = { tags: ["a"], created: "2026-02-13", updated: "2026-02-13", category: undefined };
    const s = serializeFrontmatter(fm);
    expect(s).toContain("---");
    expect(s).toContain("tags:");
    expect(s).toContain("2026-02-13");
  });

  it("should include category when set", () => {
    const fm = {
      tags: [],
      created: "2026-02-13",
      updated: "2026-02-13",
      category: "people",
    };
    const s = serializeFrontmatter(fm);
    expect(s).toContain("category");
    expect(s).toContain("people");
  });
});

describe("parseFrontmatter", () => {
  it("should return full content as body when no frontmatter", () => {
    const result = parseFrontmatter("just body");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("just body");
  });

  it("should parse frontmatter and body", () => {
    const raw = "---\ntags: [\"a\", \"b\"]\ncreated: 2026-02-13\nupdated: 2026-02-14\n---\n# Title\n\nBody.";
    const result = parseFrontmatter(raw);
    expect(result.frontmatter.tags).toEqual(["a", "b"]);
    expect(result.body).toContain("# Title");
  });
});

describe("serializeNote", () => {
  it("should include frontmatter and content", () => {
    const note = createNote({ path: "x.md", title: "X", content: "Body" });
    const s = serializeNote(note);
    expect(s).toContain("---");
    expect(s).toContain("# X");
    expect(s).toContain("Body");
  });
});
