/**
 * @fileoverview Tests for approved-tools helpers (getApprovedToolSlugs, isToolRegistered).
 */
import { describe, it, expect } from "bun:test";
import { getApprovedToolSlugs, isToolRegistered } from "@/lib/tools/approved-tools";
import { makeTestDb } from "../../helpers/db";

describe("approved-tools", () => {
  it("getApprovedToolSlugs returns empty array when no tools approved", () => {
    const db = makeTestDb();
    expect(getApprovedToolSlugs(db)).toEqual([]);
  });

  it("isToolRegistered returns false when slug not in table", () => {
    const db = makeTestDb();
    expect(isToolRegistered(db, "my-tool")).toBe(false);
  });

  it("getApprovedToolSlugs returns slugs after insert", () => {
    const db = makeTestDb();
    db.prepare(
      "INSERT INTO approved_tools (tool_slug, approved_at) VALUES (?, ?)",
    ).run("my-tool", "2025-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO approved_tools (tool_slug, approved_at) VALUES (?, ?)",
    ).run("other-tool", "2025-01-02T00:00:00.000Z");
    const slugs = getApprovedToolSlugs(db);
    expect(slugs).toContain("my-tool");
    expect(slugs).toContain("other-tool");
    expect(slugs.length).toBe(2);
  });

  it("isToolRegistered returns true when slug is in table", () => {
    const db = makeTestDb();
    db.prepare(
      "INSERT INTO approved_tools (tool_slug, approved_at) VALUES (?, ?)",
    ).run("my-tool", "2025-01-01T00:00:00.000Z");
    expect(isToolRegistered(db, "my-tool")).toBe(true);
    expect(isToolRegistered(db, "other-tool")).toBe(false);
  });
});
