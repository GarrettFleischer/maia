import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { fireHeartbeat } from "@/lib/heartbeat";
import { runAgent } from "@/lib/agent/runner";
import { createProvider } from "@/lib/ai/factory";

export async function POST() {
  const ctx = await ensureAppContext();
  const runAgentFn = async (
    c: typeof ctx,
    agentId: string,
    sessionId: string,
    message: string
  ): Promise<void> => {
    await runAgent(c, createProvider, agentId, sessionId, message, () => {});
  };
  await fireHeartbeat(ctx, runAgentFn);
  return NextResponse.json({ ok: true, timestamp: new Date().toISOString() });
}
