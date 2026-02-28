/**
 * @fileoverview Tests for GET/PUT/DELETE /api/skills/[id].
 * @module __tests__/app/api/skills/[id]/route.test
 */
import path from "path";
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext, FakeFs } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET, PUT, DELETE } from "@/app/api/skills/[id]/route";
import { getSkillsDir, getAgentSkillsDir } from "@/lib/data-dir";

const validSkillContent = `---
name: commit-style
description: Commit with conventional commits.
---

# Body content
`;

async function getParams(id: string) {
  return Promise.resolve({ id });
}

describe("GET /api/skills/[id]", () => {
  beforeEach(() => {
    const fs = new FakeFs();
    const dir = getSkillsDir();
    fs.seed(path.join(dir, "commit-style.md"), validSkillContent);
    _setTestContext(makeTestContext({ fs }));
  });

  it("returns skill content when id exists", async () => {
    const res = await GET(createNextRequest("http://localhost/api/skills/commit-style"), {
      params: getParams("commit-style"),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { name: string; description: string; content: string };
    expect(data.name).toBe("commit-style");
    expect(data.description).toContain("conventional");
    expect(data.content).toContain("Body content");
  });

  it("returns 404 when id does not exist", async () => {
    const res = await GET(createNextRequest("http://localhost/api/skills/nonexistent"), {
      params: getParams("nonexistent"),
    });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/skills/[id]", () => {
  beforeEach(() => {
    const fs = new FakeFs();
    const dir = getSkillsDir();
    fs.seed(path.join(dir, "edit-me.md"), validSkillContent);
    _setTestContext(makeTestContext({ fs }));
  });

  it("updates skill and returns 200", async () => {
    const req = createNextRequest("http://localhost/api/skills/edit-me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Updated Name",
        description: "Updated description.",
        content: "# New body",
      }),
    });
    const res = await PUT(req, { params: getParams("edit-me") });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { skill: { name: string; description: string } };
    expect(data.skill.name).toBe("Updated Name");
    expect(data.skill.description).toBe("Updated description.");
  });
});

describe("DELETE /api/skills/[id]", () => {
  beforeEach(() => {
    const fs = new FakeFs();
    const dir = getSkillsDir();
    fs.seed(path.join(dir, "to-delete.md"), validSkillContent);
    _setTestContext(makeTestContext({ fs }));
  });

  it("deletes skill and returns 204", async () => {
    const res = await DELETE(
      createNextRequest("http://localhost/api/skills/to-delete"),
      { params: getParams("to-delete") },
    );
    expect(res.status).toBe(204);
  });

  it("returns 404 when id does not exist", async () => {
    const res = await DELETE(
      createNextRequest("http://localhost/api/skills/nonexistent"),
      { params: getParams("nonexistent") },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/skills/[id] for agent skill", () => {
  beforeEach(() => {
    const fs = new FakeFs();
    const dir = getAgentSkillsDir("maia");
    fs.seed(path.join(dir, "agent-skill.md"), validSkillContent);
    _setTestContext(makeTestContext({ fs }));
  });

  it("returns agent skill when id is agentId/slug", async () => {
    const res = await GET(createNextRequest("http://localhost/api/skills/maia/agent-skill"), {
      params: getParams("maia/agent-skill"),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { name: string };
    expect(data.name).toBe("commit-style");
  });
});
