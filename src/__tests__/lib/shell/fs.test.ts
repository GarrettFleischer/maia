/**
 * @fileoverview Tests for sandboxed hybrid filesystem and logical path mapping.
 * @module __tests__/lib/shell/fs.test
 */
import { describe, it, expect } from "bun:test";
import path from "path";
import { HybridFileSystem, type FsPolicy } from "@/lib/shell/fs";
import { FakeFs } from "@/__tests__/helpers/fakes";

function makeRoots() {
  const sandboxRoot = path.join("/", "sandbox");
  const systemRoot = path.join(sandboxRoot, "agents");
  const identityRoot = path.join(systemRoot, "maia");
  const workspaceRoot = path.join(identityRoot, "workspace");
  return { sandboxRoot, systemRoot, identityRoot, workspaceRoot };
}

describe("HybridFileSystem", () => {
  it("maps ~, ~/.., and ~/../.. to workspace, identity, and system roots", () => {
    const roots = makeRoots();
    const realFs = new FakeFs();
    const policy: FsPolicy = {
      isRealPath: () => true,
      isReadOnly: () => false,
    };

    const fs = new HybridFileSystem(
      {
        sandboxRoot: roots.sandboxRoot,
        workspaceRoot: roots.workspaceRoot,
        identityRoot: roots.identityRoot,
        systemRoot: roots.systemRoot,
      },
      realFs,
      policy,
    );

    expect(fs.resolveHostPath("~")).toBe(roots.workspaceRoot);
    expect(fs.resolveHostPath("~/..")).toBe(roots.identityRoot);
    expect(fs.resolveHostPath("~/../..")).toBe(roots.systemRoot);
  });

  it("enforces sandbox root and prevents escaping above it with .. segments", () => {
    const roots = makeRoots();
    const realFs = new FakeFs();
    const policy: FsPolicy = {
      isRealPath: () => true,
      isReadOnly: () => false,
    };

    const fs = new HybridFileSystem(
      {
        sandboxRoot: roots.sandboxRoot,
        workspaceRoot: roots.workspaceRoot,
        identityRoot: roots.identityRoot,
        systemRoot: roots.systemRoot,
      },
      realFs,
      policy,
    );

    const escaped = fs.resolveHostPath("~/../../../../..");
    expect(escaped.startsWith(roots.sandboxRoot)).toBe(true);
  });

  it("stores files under a virtual layer when policy marks path as non-real", () => {
    const roots = makeRoots();
    const realFs = new FakeFs();
    const policy: FsPolicy = {
      isRealPath: (logicalPath: string): boolean => !logicalPath.startsWith("~/.virtual"),
      isReadOnly: () => false,
    };

    const fs = new HybridFileSystem(
      {
        sandboxRoot: roots.sandboxRoot,
        workspaceRoot: roots.workspaceRoot,
        identityRoot: roots.identityRoot,
        systemRoot: roots.systemRoot,
      },
      realFs,
      policy,
    );

    const logicalPath = "~/.virtual/file.txt";
    fs.writeFile(logicalPath, "hello virtual");

    // Underlying real filesystem should not see this path.
    const host = fs.resolveHostPath(logicalPath);
    expect(realFs.exists(host)).toBe(false);

    // Reading via the hybrid filesystem should return the virtual content.
    const content = fs.readFile(logicalPath);
    expect(content).toBe("hello virtual");
  });
});

