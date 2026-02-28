/**
 * @fileoverview Tests for GET/POST /api/skills.
 * @module __tests__/app/api/skills/route.test
 */
import path from "path";
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext, FakeFs } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET, POST } from "@/app/api/skills/route";
import { getSkillsDir, getAgentSkillsDir } from "@/lib/data-dir";

const validSkillContent = `---
name: commit-style
description: Commit with conventional commits.
---

# Body
`;

describe("GET /api/skills", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns empty list when no skills exist", async () => {
    const req = createNextRequest("http://localhost/api/skills?scope=global");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { skills: unknown[] };
    expect(data.skills).toEqual([]);
  });

  it("returns 400 when scope=agent without agentId", async () => {
    const req = createNextRequest("http://localhost/api/skills?scope=agent");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns global skills when scope=global and files exist", async () => {
    const fs = new FakeFs();
    const dir = getSkillsDir();
    fs.seed(path.join(dir, "commit-style.md"), validSkillContent);
    _setTestContext(makeTestContext({ fs }));

    const req = createNextRequest("http://localhost/api/skills?scope=global");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { skills: { id: string; name: string; description: string }[] };
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0].id).toBe("commit-style");
    expect(data.skills[0].name).toBe("commit-style");
    expect(data.skills[0].description).toContain("conventional");
  });

  it("returns agent skills when scope=agent and agentId set", async () => {
    const fs = new FakeFs();
    const dir = getAgentSkillsDir("maia");
    fs.seed(path.join(dir, "my-skill.md"), validSkillContent);
    _setTestContext(makeTestContext({ fs }));

    const req = createNextRequest("http://localhost/api/skills?scope=agent&agentId=maia");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { skills: { id: string; name: string }[] };
    expect(data.skills).toHaveLength(1);
    expect(data.skills[0].id).toBe("maia/my-skill");
  });
});

describe("POST /api/skills", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext({ fs: new FakeFs() }));
  });

  it("creates a global skill and returns 201", async () => {
    const req = createNextRequest("http://localhost/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        filename: "new-skill",
        name: "New Skill",
        description: "Does something.",
        content: "# Instructions",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = (await res.json()) as { skill: { id: string; name: string; scope: string } };
    expect(data.skill.id).toBe("new-skill");
    expect(data.skill.name).toBe("New Skill");
    expect(data.skill.scope).toBe("global");
  });

  it("returns 400 when name or description missing", async () => {
    const req = createNextRequest("http://localhost/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        filename: "x",
        name: "",
        description: "Y",
        content: "",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when filename invalid", async () => {
    const req = createNextRequest("http://localhost/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        filename: "bad name!",
        name: "X",
        description: "Y",
        content: "",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
