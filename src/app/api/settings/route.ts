import { NextRequest, NextResponse } from "next/server";
import { getSettingsPublic, updateSettings } from "@/lib/settings";

export async function GET() {
  return NextResponse.json(getSettingsPublic());
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  updateSettings(body);
  return NextResponse.json(getSettingsPublic());
}
