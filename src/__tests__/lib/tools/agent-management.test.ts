import { describe, it, expect } from "bun:test";
import path from "path";
import { copyDefaultAgentFiles } from "@/lib/tools/agent-management";
import { getAgentsDir, getDefaultAgentDir, getDefaultMaiaDir } from "@/lib/data-dir";
import { makeTestContext, FakeFs } from "../../helpers/fakes";

describe("copyDefaultAgentFiles", () => {
  it("uses defaults/maia/PERSONA.md for Maia when present", () => {
    const fs = new FakeFs();
    const maiaPersonaPath = path.join(getDefaultMaiaDir(), "PERSONA.md");
    const maiaContent = "# Maia persona\n\nOrchestrator defaults.";
    fs.seed(maiaPersonaPath, maiaContent);
    const ctx = makeTestContext({ fs });
    const agentDir = path.join(getAgentsDir(), "maia");
    copyDefaultAgentFiles(ctx, agentDir, "Maia", "maia");
    const written = fs.snapshot()[path.join(agentDir, "PERSONA.md")];
    expect(written).toBe(maiaContent);
  });

  it("falls back to defaults/agent PERSONA.md for Maia when defaults/maia/PERSONA.md is missing", () => {
    const fs = new FakeFs();
    const agentPersonaPath = path.join(getDefaultAgentDir(), "PERSONA.md");
    const agentContent = "# Generic persona\nFallback.";
    fs.seed(agentPersonaPath, agentContent);
    const ctx = makeTestContext({ fs });
    const agentDir = path.join(getAgentsDir(), "maia");
    copyDefaultAgentFiles(ctx, agentDir, "Maia", "maia");
    const written = fs.snapshot()[path.join(agentDir, "PERSONA.md")];
    expect(written).toBe(agentContent);
  });

  it("substitutes {{name}} in generic PERSONA templates", () => {
    const fs = new FakeFs();
    fs.seed(path.join(getDefaultAgentDir(), "PERSONA.md"), "# Hi {{name}}\n");
    const ctx = makeTestContext({ fs });
    const agentDir = path.join(getAgentsDir(), "sub");
    copyDefaultAgentFiles(ctx, agentDir, "Robin");
    expect(fs.snapshot()[path.join(agentDir, "PERSONA.md")]).toContain("Robin");
  });

  it("copies fact .md files from defaults user/ and memory/ into agent user/ and memory/", () => {
    const fs = new FakeFs();
    const defaultMaia = getDefaultMaiaDir();
    fs.seed(path.join(defaultMaia, "PERSONA.md"), "# Maia persona\n");
    fs.seed(path.join(defaultMaia, "user", "preference.md"), "User prefers TDD.");
    fs.seed(path.join(defaultMaia, "memory", "project-fact.md"), "Project uses Bun.");
    const ctx = makeTestContext({ fs });
    const agentDir = path.join(getAgentsDir(), "maia");
    copyDefaultAgentFiles(ctx, agentDir, "Maia", "maia");
    const snap = fs.snapshot();
    expect(snap[path.join(agentDir, "user", "preference.md")]).toBe("User prefers TDD.");
    expect(snap[path.join(agentDir, "memory", "project-fact.md")]).toBe("Project uses Bun.");
  });
});
