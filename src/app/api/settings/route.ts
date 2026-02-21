import { NextRequest, NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { getSettingsPublic, updateSettings } from "@/lib/settings";

export async function GET() {
  const ctx = await ensureAppContext();
  return NextResponse.json(getSettingsPublic(ctx));
}

export async function PUT(req: NextRequest) {
  const ctx = await ensureAppContext();
  const body = await req.json();
  updateSettings(ctx, body);
  return NextResponse.json(getSettingsPublic(ctx));
}
