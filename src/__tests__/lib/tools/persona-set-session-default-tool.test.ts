/**
 * @fileoverview Tests for persona_set_session_default tool.
 * @module __tests__/lib/tools/persona-set-session-default-tool.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";
import { personaSetSessionDefaultTool } from "@/lib/tools/personas-tools";
import {
  createSession,
  getSessionDefaultPersonaId,
} from "@/lib/history";

describe("persona_set_session_default", () => {
  let ctx: ReturnType<typeof makeTestContext>;
  let sessionId: string;
  let toolCtx: ToolContext;

  beforeEach(() => {
    ctx = makeTestContext();
    sessionId = createSession(ctx, ["user", "maia"], "user");
    toolCtx = {
      ...ctx,
      agentId: "maia",
      sessionId,
      volumeRoot: "/unused",
      defaultCwd: "/unused",
      providerFactory: () => {
        throw new Error("not used");
      },
      getToolsForAgent: () => [],
    };
  });

  it("rejects non user+Maia threads", async () => {
    const sid = createSession(ctx, ["user", "custom"], "user");
    const res = await personaSetSessionDefaultTool.execute(
      { persona_id: "typescript-pro" },
      { ...toolCtx, sessionId: sid },
    );
    expect(String(res)).toContain("only applies");
  });

  it("sets default persona and emits session_updated", async () => {
    const res = await personaSetSessionDefaultTool.execute(
      { persona_id: "typescript-pro" },
      toolCtx,
    );
    expect(String(res)).toContain("Default persona");
    expect(getSessionDefaultPersonaId(ctx, sessionId)).toBe("typescript-pro");
    const ev = ctx.events.emitted.find((e) => e.event === "session_updated");
    expect(ev?.event).toBe("session_updated");
    if (ev?.event === "session_updated") {
      expect(ev.data.sessionId).toBe(sessionId);
      expect(ev.data.defaultPersonaId).toBe("typescript-pro");
    }
  });

  it("clears default with null", async () => {
    await personaSetSessionDefaultTool.execute(
      { persona_id: "typescript-pro" },
      toolCtx,
    );
    await personaSetSessionDefaultTool.execute({ persona_id: null }, toolCtx);
    expect(getSessionDefaultPersonaId(ctx, sessionId)).toBeNull();
    const clears = ctx.events.emitted.filter((e) => e.event === "session_updated");
    const last = clears[clears.length - 1];
    expect(last?.event).toBe("session_updated");
    if (last?.event === "session_updated") {
      expect(last.data.defaultPersonaId).toBeNull();
    }
  });
});
