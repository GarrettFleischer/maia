import { describe, it, expect } from "bun:test";
import {
  threadListTool,
  threadCreateTool,
  threadUpdateTool,
  threadDeleteTool,
  threadGetActiveTool,
  threadSetActiveTool,
} from "@/lib/tools/thread-management";
import { makeTestContext } from "../../helpers/fakes";
import { createSession, getSession, listSessions, getActiveSessionId } from "@/lib/history";
import type { ToolContext } from "@/lib/tools/types";
import type { SessionMeta } from "@/lib/types";
import type { AppContext } from "@/lib/context";

function makeToolCtx(ctx: AppContext, sessionId: string): ToolContext {
  return { ...ctx, agentId: "maia", sessionId, volumeRoot: "/workspace" };
}

describe("threadListTool", () => {
  it("returns empty list when no sessions", async () => {
    const ctx = makeTestContext();
    const toolCtx = makeToolCtx(ctx, "s1");
    const result = await threadListTool.execute({}, toolCtx) as SessionMeta[];
    expect(result).toEqual([]);
  });

  it("returns all sessions when type is all or omitted", async () => {
    const ctx = makeTestContext();
    createSession(ctx, ["user", "maia"], "user");
    createSession(ctx, ["a", "b"], "agents");
    const toolCtx = makeToolCtx(ctx, "s1");
    const result = await threadListTool.execute({}, toolCtx) as SessionMeta[];
    expect(result).toHaveLength(2);
  });

  it("filters to user sessions when type=user", async () => {
    const ctx = makeTestContext();
    createSession(ctx, ["user", "maia"], "user");
    createSession(ctx, ["a", "b"], "agents");
    const toolCtx = makeToolCtx(ctx, "s1");
    const result = await threadListTool.execute({ type: "user" }, toolCtx) as SessionMeta[];
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("user");
  });

  it("filters to agents sessions when type=agents", async () => {
    const ctx = makeTestContext();
    createSession(ctx, ["user", "maia"], "user");
    createSession(ctx, ["a", "b"], "agents");
    const toolCtx = makeToolCtx(ctx, "s1");
    const result = await threadListTool.execute({ type: "agents" }, toolCtx) as SessionMeta[];
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("agents");
  });
});

describe("threadCreateTool", () => {
  it("creates a session and returns its ID", async () => {
    const ctx = makeTestContext();
    const toolCtx = makeToolCtx(ctx, "s1");
    const id = await threadCreateTool.execute({}, toolCtx) as string;
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("creates user-type session by default", async () => {
    const ctx = makeTestContext();
    const toolCtx = makeToolCtx(ctx, "s1");
    const id = await threadCreateTool.execute({}, toolCtx) as string;
    const session = getSession(ctx, id);
    expect(session?.type).toBe("user");
    expect(session?.participants).toEqual(["user", "maia"]);
  });

  it("creates agents-type session when specified", async () => {
    const ctx = makeTestContext();
    const toolCtx = makeToolCtx(ctx, "s1");
    const id = await threadCreateTool.execute({ type: "agents", participants: ["agent-a", "agent-b"] }, toolCtx) as string;
    const session = getSession(ctx, id);
    expect(session?.type).toBe("agents");
    expect(session?.participants).toEqual(["agent-a", "agent-b"]);
  });
});

describe("threadUpdateTool", () => {
  it("updates session name", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    const toolCtx = makeToolCtx(ctx, sessionId);
    await threadUpdateTool.execute({ id: sessionId, name: "My Thread" }, toolCtx);
    const session = getSession(ctx, sessionId);
    expect(session?.name).toBe("My Thread");
  });

  it("updates session description", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    const toolCtx = makeToolCtx(ctx, sessionId);
    await threadUpdateTool.execute({ id: sessionId, desc: "A test thread" }, toolCtx);
    const session = getSession(ctx, sessionId);
    expect(session?.description).toBe("A test thread");
  });

  it("updates session tags", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    const toolCtx = makeToolCtx(ctx, sessionId);
    await threadUpdateTool.execute({ id: sessionId, tags: ["work", "urgent"] }, toolCtx);
    const session = getSession(ctx, sessionId);
    expect(session?.tags).toEqual(["work", "urgent"]);
  });

  it("updates multiple fields at once", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    const toolCtx = makeToolCtx(ctx, sessionId);
    await threadUpdateTool.execute({
      id: sessionId,
      name: "Named",
      desc: "Described",
      tags: ["a"],
    }, toolCtx);
    const session = getSession(ctx, sessionId);
    expect(session?.name).toBe("Named");
    expect(session?.description).toBe("Described");
    expect(session?.tags).toEqual(["a"]);
  });
});

describe("threadDeleteTool", () => {
  it("deletes a session and returns true", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    const toolCtx = makeToolCtx(ctx, sessionId);
    const result = await threadDeleteTool.execute({ id: sessionId }, toolCtx) as boolean;
    expect(result).toBe(true);
    expect(getSession(ctx, sessionId)).toBeNull();
    expect(listSessions(ctx, "all").some((s) => s.id === sessionId)).toBe(false);
  });

  it("returns false for non-existent session", async () => {
    const ctx = makeTestContext();
    const toolCtx = makeToolCtx(ctx, "s1");
    const result = await threadDeleteTool.execute({ id: "nonexistent" }, toolCtx) as boolean;
    expect(result).toBe(false);
  });

  it("clears active session when deleted session was active", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    const toolCtx = makeToolCtx(ctx, sessionId);
    await threadSetActiveTool.execute({ id: sessionId }, toolCtx);
    expect(getActiveSessionId(ctx)).toBe(sessionId);
    await threadDeleteTool.execute({ id: sessionId }, toolCtx);
    expect(getActiveSessionId(ctx)).toBeNull();
  });
});

describe("threadGetActiveTool", () => {
  it("returns null when no active session", async () => {
    const ctx = makeTestContext();
    const toolCtx = makeToolCtx(ctx, "s1");
    const result = await threadGetActiveTool.execute({}, toolCtx) as string | null;
    expect(result).toBeNull();
  });

  it("returns active session id when set", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    const toolCtx = makeToolCtx(ctx, sessionId);
    await threadSetActiveTool.execute({ id: sessionId }, toolCtx);
    const result = await threadGetActiveTool.execute({}, toolCtx) as string | null;
    expect(result).toBe(sessionId);
  });
});

describe("threadSetActiveTool", () => {
  it("sets the active session", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    const toolCtx = makeToolCtx(ctx, "other");
    await threadSetActiveTool.execute({ id: sessionId }, toolCtx);
    expect(getActiveSessionId(ctx)).toBe(sessionId);
  });

  it("overwrites previous active session", async () => {
    const ctx = makeTestContext();
    const id1 = createSession(ctx, ["user", "maia"]);
    const id2 = createSession(ctx, ["user", "maia"]);
    const toolCtx = makeToolCtx(ctx, id1);
    await threadSetActiveTool.execute({ id: id1 }, toolCtx);
    expect(getActiveSessionId(ctx)).toBe(id1);
    await threadSetActiveTool.execute({ id: id2 }, toolCtx);
    expect(getActiveSessionId(ctx)).toBe(id2);
  });
});
