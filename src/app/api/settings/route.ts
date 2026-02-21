import { NextRequest, NextResponse } from "next/server";
import { getAppContext } from "@/instrumentation";
import { getSettingsPublic, updateSettings } from "@/lib/settings";

export async function GET() {
  const ctx = getAppContext();
  return NextResponse.json(getSettingsPublic(ctx));
}

export async function PUT(req: NextRequest) {
  const ctx = getAppContext();
  const body = await req.json();
  updateSettings(ctx, body);
  return NextResponse.json(getSettingsPublic(ctx));
}
