import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { fireHeartbeat } from "@/lib/heartbeat";
import { runAgent, type RunAgentFn } from "@/lib/agent/runner";
import { createProvider } from "@/lib/ai/factory";
import { initMessagingService } from "@/lib/messaging-service";

export async function POST() {
  console.debug("[Heartbeat] Triggered via POST /api/cron/heartbeat", {
    timestamp: new Date().toISOString(),
  });
  const ctx = await ensureAppContext();
  const runAgentFn: RunAgentFn = (c, agentId, sessionId, message, options) =>
    runAgent(c, createProvider, agentId, sessionId, message, () => {}, options);
  initMessagingService(ctx, runAgentFn);
  await fireHeartbeat(ctx, runAgentFn);
  return NextResponse.json({ ok: true, timestamp: new Date().toISOString() });
}
