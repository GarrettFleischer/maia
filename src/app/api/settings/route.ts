import { NextRequest, NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { getSettingsPublic, updateSettings } from "@/lib/settings";

export async function GET() {
  const ctx = await ensureAppContext();
  return NextResponse.json(getSettingsPublic(ctx));
}

export async function PUT(req: NextRequest) {
  const ctx = await ensureAppContext();
  const body = (await req.json()) as Record<string, unknown>;
  try {
    updateSettings(ctx, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Embedding model must be in whitelist")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    throw err;
  }
  if (body.heartbeatIntervalMinutes !== undefined) {
    const { refreshHeartbeatJob } = await import("@/lib/cron/service");
    refreshHeartbeatJob(ctx);
  }
  return NextResponse.json(getSettingsPublic(ctx));
}
