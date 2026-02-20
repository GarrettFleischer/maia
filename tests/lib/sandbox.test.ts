/**
 * @fileoverview Tests for sandbox path resolution.
 * @module tests/lib/sandbox.test
 */

import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  resolveSandboxRoot,
  resolveWithinSandbox,
} from "@/lib/sandbox";

describe("resolveSandboxRoot", () => {
  it("returns path ending with .maia when MAIA_HOME not set", () => {
    const root = resolveSandboxRoot({}, () => "/home/user");
    expect(root).toBe(path.join("/home", "user", ".maia"));
  });

  it("uses MAIA_HOME when set", () => {
    const root = resolveSandboxRoot(
      { MAIA_HOME: "/custom/maia" },
      () => "/home/user"
    );
    expect(root).toBe("/custom/maia");
  });
});

describe("resolveWithinSandbox", () => {
  const root = "C:\\maia";

  it("resolves relative path within sandbox", () => {
    const res = resolveWithinSandbox(root, "agent-1/HEARTBEAT.md");
    expect(res).not.toBeNull();
    expect(res).toContain("maia");
    expect(res).toContain("agent-1");
  });

  it("returns null for path escaping with ..", () => {
    const res = resolveWithinSandbox(root, "../etc/passwd");
    expect(res).toBeNull();
  });

  it("returns null for path escaping with .. in middle", () => {
    const res = resolveWithinSandbox(root, "agent-1/../../etc/passwd");
    expect(res).toBeNull();
  });
});
