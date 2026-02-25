import { NextRequest, NextResponse } from "next/server";
import { getAppContext } from "@/instrumentation";
import { searchEntries } from "@/lib/history";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = getAppContext();
  const { id } = await params;
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const mode = req.nextUrl.searchParams.get("mode") as "compressed" | "original" | "both" | null;
  const entries = searchEntries(ctx, q, id, mode ?? "both");
  return NextResponse.json({ entries });
}
