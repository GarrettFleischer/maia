import { NextResponse } from "next/server";
import { fireHeartbeat } from "@/lib/heartbeat";

export async function POST() {
  await fireHeartbeat();
  return NextResponse.json({ ok: true, timestamp: new Date().toISOString() });
}
