/**
 * @fileoverview Tests for POST /api/conversations/[id]/send.
 * @module tests/api/send.test
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { POST } from "@/app/api/conversations/[id]/send/route";

const API_KEY = "test-api-key-32-chars-long!!!!!!";
const TMP = path.join(process.cwd(), "tmp-send-" + Date.now());

describe("POST /api/conversations/[id]/send", () => {
  afterAll(() => {
    if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("returns 400 when content is missing", async () => {
    const origKey = process.env.MAIA_API_KEY;
    const origDb = process.env.MAIA_DB_PATH;
    const origHome = process.env.MAIA_HOME;
    process.env.MAIA_API_KEY = API_KEY;
    process.env.MAIA_DB_PATH = path.join(TMP, "db.sqlite");
    process.env.MAIA_HOME = TMP;
    fs.mkdirSync(TMP, { recursive: true });

    const request = new Request(
      "http://localhost/api/conversations/conv-1/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request, {
      params: Promise.resolve({ id: "conv-1" }),
    });

    process.env.MAIA_API_KEY = origKey;
    process.env.MAIA_DB_PATH = origDb;
    process.env.MAIA_HOME = origHome;
    expect(response.status).toBe(400);
  });

  it("returns 404 when conversation does not exist", async () => {
    const origKey = process.env.MAIA_API_KEY;
    const origDb = process.env.MAIA_DB_PATH;
    const origHome = process.env.MAIA_HOME;
    process.env.MAIA_API_KEY = API_KEY;
    process.env.MAIA_DB_PATH = path.join(TMP, "db.sqlite");
    process.env.MAIA_HOME = TMP;

    const request = new Request(
      "http://localhost/api/conversations/nonexistent-id/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Hello" }),
      },
    );
    const response = await POST(request, {
      params: Promise.resolve({ id: "nonexistent-id" }),
    });

    process.env.MAIA_API_KEY = origKey;
    process.env.MAIA_DB_PATH = origDb;
    process.env.MAIA_HOME = origHome;
    expect(response.status).toBe(404);
  });

  it("returns 403 when conversation type is not user_chat and does not append message", async () => {
    const origKey = process.env.MAIA_API_KEY;
    const origDb = process.env.MAIA_DB_PATH;
    const origHome = process.env.MAIA_HOME;
    process.env.MAIA_API_KEY = API_KEY;
    const dbPath = path.join(TMP, "db-403-" + Date.now() + ".sqlite");
    process.env.MAIA_DB_PATH = dbPath;
    process.env.MAIA_HOME = TMP;
    fs.mkdirSync(TMP, { recursive: true });

    const { openDb } = await import("@/db/client");
    const { createAgentRepository } = await import("@/db/agents");
    const { createConversationRepository } = await import("@/db/conversations");
    const { createMessageRepository } = await import("@/db/messages");
    const db = await openDb(dbPath);
    const agentRepo = createAgentRepository(db, TMP, {
      mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    });
    const created = await agentRepo.create({
      name: "SendTest",
      purpose: "Test",
    });
    const convRepo = createConversationRepository(db);
    const convId = await convRepo.create(
      created.id,
      "agent_chat",
      "other-agent-id",
    );
    const msgRepo = createMessageRepository(db);
    const countBefore = (await msgRepo.listByConversation(convId)).length;
    db.close();

    const request = new Request(
      `http://localhost/api/conversations/${convId}/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Hello" }),
      },
    );
    const response = await POST(request, {
      params: Promise.resolve({ id: convId }),
    });

    expect(response.status).toBe(403);
    const json = (await response.json()) as { error?: string };
    expect(json.error).toBe("Sending is only allowed in user chats");

    const db2 = await openDb(dbPath);
    const msgRepo2 = createMessageRepository(db2);
    const countAfter = (await msgRepo2.listByConversation(convId)).length;
    db2.close();
    expect(countAfter).toBe(countBefore);

    process.env.MAIA_API_KEY = origKey;
    process.env.MAIA_DB_PATH = origDb;
    process.env.MAIA_HOME = origHome;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it("returns 200 with error content when agent runs but Ollama fails", async () => {
    const origKey = process.env.MAIA_API_KEY;
    const origDb = process.env.MAIA_DB_PATH;
    const origHome = process.env.MAIA_HOME;
    process.env.MAIA_API_KEY = API_KEY;
    process.env.MAIA_DB_PATH = path.join(TMP, "db.sqlite");
    process.env.MAIA_HOME = TMP;
    fs.mkdirSync(TMP, { recursive: true });

    const { openDb } = await import("@/db/client");
    const { createAgentRepository } = await import("@/db/agents");
    const { createConversationRepository } = await import("@/db/conversations");
    const db = await openDb(process.env.MAIA_DB_PATH);
    const agentRepo = createAgentRepository(db, TMP, {
      mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    });
    const created = await agentRepo.create({
      name: "SendTest",
      purpose: "Test",
    });
    const convRepo = createConversationRepository(db);
    const convId = await convRepo.create(created.id, "user_chat", null);
    db.close();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("Server error", { status: 500 })) as unknown as typeof fetch;
    try {
      const request = new Request(
        `http://localhost/api/conversations/${convId}/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "Hello" }),
        },
      );
      const response = await POST(request, {
        params: Promise.resolve({ id: convId }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No body");
      const decoder = new TextDecoder();
      let lastContent: string | undefined;
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const data = JSON.parse(line) as {
            delta?: string;
            done?: boolean;
            content?: string;
          };
          if (data.content !== undefined) lastContent = data.content;
        }
      }
      expect(lastContent).toBeDefined();
      expect(String(lastContent)).toMatch(/\[Error:|\[Blocked:/);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.MAIA_API_KEY = origKey;
      process.env.MAIA_DB_PATH = origDb;
      process.env.MAIA_HOME = origHome;
    }
  });
});
