/**
 * @fileoverview Integration tests for agents API.
 * @module tests/api/agents.test
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { GET, POST } from "@/app/api/agents/route";
import { createAgentRepository, MAIA_AGENT_ID } from "@/db/agents";
import { openDb } from "@/db/client";
import { createContainer } from "@/lib/container";

const API_KEY = "test-api-key-32-chars-long!!!!!!";
const TMP = path.join(process.cwd(), "tmp-api-agents-" + Date.now());

function cleanupTmp(): void {
  if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
}

describe("GET /api/agents", () => {
  afterAll(cleanupTmp);

  it("returns 401 without auth", async () => {
    const origKey = process.env.MAIA_API_KEY;
    const origDb = process.env.MAIA_DB_PATH;
    const origHome = process.env.MAIA_HOME;
    process.env.MAIA_API_KEY = API_KEY;
    process.env.MAIA_DB_PATH = path.join(TMP, "db.sqlite");
    process.env.MAIA_HOME = TMP;
    fs.mkdirSync(TMP, { recursive: true });
    const request = new Request("http://localhost/api/agents");
    const response = await GET(request);
    process.env.MAIA_API_KEY = origKey;
    process.env.MAIA_DB_PATH = origDb;
    process.env.MAIA_HOME = origHome;
    expect(response.status).toBe(401);
  });

  it("returns 200 and array with auth", async () => {
    const origKey = process.env.MAIA_API_KEY;
    const origDb = process.env.MAIA_DB_PATH;
    const origHome = process.env.MAIA_HOME;
    process.env.MAIA_API_KEY = API_KEY;
    process.env.MAIA_DB_PATH = path.join(TMP, "db.sqlite");
    process.env.MAIA_HOME = TMP;
    fs.mkdirSync(TMP, { recursive: true });
    const request = new Request("http://localhost/api/agents", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const response = await GET(request);
    process.env.MAIA_API_KEY = origKey;
    process.env.MAIA_DB_PATH = origDb;
    process.env.MAIA_HOME = origHome;
    expect(response.status).toBe(200);
    const data = (await response.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it("includes Maia agent (id maia, name Maia)", async () => {
    const origKey = process.env.MAIA_API_KEY;
    const origDb = process.env.MAIA_DB_PATH;
    const origHome = process.env.MAIA_HOME;
    process.env.MAIA_API_KEY = API_KEY;
    process.env.MAIA_DB_PATH = path.join(TMP, "db.sqlite");
    process.env.MAIA_HOME = TMP;
    fs.mkdirSync(TMP, { recursive: true });
    const container = createContainer();
    const db = await openDb(container.dbPath);
    const repo = createAgentRepository(db, container.sandboxRoot, {
      mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    });
    if (!(await repo.get(MAIA_AGENT_ID))) {
      await repo.create({
        id: MAIA_AGENT_ID,
        name: "Maia",
        purpose: "Main assistant",
        model: null,
      });
    }
    db.close();
    const request = new Request("http://localhost/api/agents", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const response = await GET(request);
    process.env.MAIA_API_KEY = origKey;
    process.env.MAIA_DB_PATH = origDb;
    process.env.MAIA_HOME = origHome;
    expect(response.status).toBe(200);
    const data = (await response.json()) as { id: string; name: string }[];
    const maia = data.find((a) => a.id === "maia");
    expect(maia).toBeDefined();
    expect(maia?.name).toBe("Maia");
  });

  it("ensures single Maia agent on repeated GET (idempotent)", async () => {
    const origKey = process.env.MAIA_API_KEY;
    const origDb = process.env.MAIA_DB_PATH;
    const origHome = process.env.MAIA_HOME;
    process.env.MAIA_API_KEY = API_KEY;
    process.env.MAIA_DB_PATH = path.join(TMP, "db.sqlite");
    process.env.MAIA_HOME = TMP;
    fs.mkdirSync(TMP, { recursive: true });
    const container = createContainer();
    const db = await openDb(container.dbPath);
    const repo = createAgentRepository(db, container.sandboxRoot, {
      mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    });
    if (!(await repo.get(MAIA_AGENT_ID))) {
      await repo.create({
        id: MAIA_AGENT_ID,
        name: "Maia",
        purpose: "Main assistant",
        model: null,
      });
    }
    db.close();
    const request = new Request("http://localhost/api/agents", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    await GET(request);
    const response2 = await GET(request);
    process.env.MAIA_API_KEY = origKey;
    process.env.MAIA_DB_PATH = origDb;
    process.env.MAIA_HOME = origHome;
    const data = (await response2.json()) as { id: string }[];
    const maiaCount = data.filter((a) => a.id === "maia").length;
    expect(maiaCount).toBe(1);
  });
});

describe("POST /api/agents", () => {
  afterAll(cleanupTmp);

  it("returns 201 and creates agent", async () => {
    const origKey = process.env.MAIA_API_KEY;
    const origDb = process.env.MAIA_DB_PATH;
    const origHome = process.env.MAIA_HOME;
    process.env.MAIA_API_KEY = API_KEY;
    process.env.MAIA_DB_PATH = path.join(TMP, "db.sqlite");
    process.env.MAIA_HOME = TMP;
    fs.mkdirSync(TMP, { recursive: true });
    const request = new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "TestBot", purpose: "Testing" }),
    });
    const response = await POST(request);
    process.env.MAIA_API_KEY = origKey;
    process.env.MAIA_DB_PATH = origDb;
    process.env.MAIA_HOME = origHome;
    expect(response.status).toBe(201);
    const data = (await response.json()) as { id: string; name: string };
    expect(data.name).toBe("TestBot");
    expect(data.id).toBeDefined();
  });
});
