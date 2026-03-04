/**
 * @fileoverview Tests for the ShellSession core shell engine wrapper, including
 * initialization, basic execution API, and core built-in commands wired through
 * the parser and filesystem abstraction.
 * @module __tests__/lib/shell/session.test
 */
import { describe, it, expect } from "bun:test";
import path from "path";
import { ShellSession } from "@/lib/shell/session";
import { HybridFileSystem } from "@/lib/shell/fs";
import { FakeFs } from "@/__tests__/helpers/fakes";
import type { FsPolicy } from "@/lib/shell/fs";

function makeSessionWithFakeFs(): ShellSession {
  const sandboxRoot = path.join(path.sep, "sandbox");
  const systemRoot = path.join(sandboxRoot, "agents");
  const identityRoot = path.join(systemRoot, "maia");
  const workspaceRoot = path.join(identityRoot, "workspace");

  const realFs = new FakeFs();
  const policy: FsPolicy = {
    isRealPath: () => true,
    isReadOnly: () => false,
  };
  const hybrid = new HybridFileSystem(
    { sandboxRoot, systemRoot, identityRoot, workspaceRoot },
    realFs,
    policy,
  );

  return new ShellSession({
    sandboxRoot,
    workspaceRoot,
    identityRoot,
    systemRoot,
    env: { FOO: "bar" },
    fs: hybrid,
  });
}

describe("ShellSession", () => {
  it("@brief initializes with tilde (~) as the logical current directory", () => {
    const session = makeSessionWithFakeFs();

    expect(session.getCwd()).toBe("~");
  });

  it("@brief exposes a runLine API that returns structured stdout, stderr, and exitCode", async () => {
    const session = makeSessionWithFakeFs();

    const result = await session.runLine("echo hello");

    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.exitCode).toBe("number");
  });

  it("@brief supports cd and pwd built-in commands using the sandboxed filesystem", async () => {
    const session = makeSessionWithFakeFs();

    const start = await session.runLine("pwd");
    expect(start.stdout.trim()).toBe("~");

    const cdResult = await session.runLine("cd ~/projects && pwd");
    expect(cdResult.exitCode).toBe(0);
    expect(cdResult.stdout.trim()).toBe("~/projects");
  });

  it("@brief supports echo and env variable expansion via the parser and built-ins", async () => {
    const session = makeSessionWithFakeFs();

    const result = await session.runLine("echo $FOO world");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("bar world");
  });

  it("@brief supports touch and ls built-ins backed by the hybrid filesystem", async () => {
    const session = makeSessionWithFakeFs();

    const touchRes = await session.runLine("touch notes.txt");
    expect(touchRes.exitCode).toBe(0);

    const lsRes = await session.runLine("ls");
    expect(lsRes.exitCode).toBe(0);
    expect(typeof lsRes.stdout).toBe("string");
  });

  it("@brief treats ls -la / ls -l etc. as listing cwd (ignores Unix-style options)", async () => {
    const session = makeSessionWithFakeFs();

    await session.runLine("touch a.txt");
    const lsPlain = await session.runLine("ls");
    const lsLa = await session.runLine("ls -la");
    const lsL = await session.runLine("ls -l");

    expect(lsLa.exitCode).toBe(0);
    expect(lsL.exitCode).toBe(0);
    expect(lsLa.stdout.trim().split(/\s+/).sort().join(" ")).toBe(
      lsPlain.stdout.trim().split(/\s+/).sort().join(" "),
    );
    expect(lsL.stdout.trim().split(/\s+/).sort().join(" ")).toBe(
      lsPlain.stdout.trim().split(/\s+/).sort().join(" "),
    );
  });

  it("@brief cd with options uses first path operand (e.g. cd -L ~/projects)", async () => {
    const session = makeSessionWithFakeFs();

    const res = await session.runLine("cd -L ~/projects && pwd");
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("~/projects");
  });

  it("@brief touch with options uses path operand (e.g. touch -a file)", async () => {
    const session = makeSessionWithFakeFs();

    const touchRes = await session.runLine("touch -a from_touch.txt");
    expect(touchRes.exitCode).toBe(0);

    const catRes = await session.runLine("cat from_touch.txt");
    expect(catRes.exitCode).toBe(0);
    expect(catRes.stdout).toBe("");
  });

  it("@brief cat with options reads path operands (e.g. cat -n file)", async () => {
    const session = makeSessionWithFakeFs();

    await session.runLine("echo hello world | cat > greet.txt");
    const res = await session.runLine("cat -n greet.txt");
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello world");
  });

  it("@brief supports simple pipelines with echo and cat", async () => {
    const session = makeSessionWithFakeFs();

    const res = await session.runLine("echo foo | cat");
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("foo");
  });

  it("@brief parses and executes heredoc (cat > file <<'EOF' ... EOF) without treating body as path", async () => {
    const session = makeSessionWithFakeFs();
    const cmd = `cat > directory_project_plan.md <<'EOF'
# Directory Website Project Plan

Great! Building a revenue‑generating directory site.
EOF`;
    const runRes = await session.runLine(cmd);
    expect(runRes.exitCode).toBe(0);
    expect(runRes.stderr).toBe("");

    const readRes = await session.runLine("cat directory_project_plan.md");
    expect(readRes.exitCode).toBe(0);
    expect(readRes.stdout).toBe(
      "# Directory Website Project Plan\n\nGreat! Building a revenue‑generating directory site.\n",
    );
  });
});
