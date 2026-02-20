import { NextRequest, NextResponse } from "next/server";
import { searchEntries } from "@/lib/history";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const mode = req.nextUrl.searchParams.get("mode") as "compressed" | "original" | "both" | null;
  const entries = searchEntries(q, id, mode ?? "both");
  return NextResponse.json({ entries });
}
