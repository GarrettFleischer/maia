import { NextRequest, NextResponse } from "next/server";
import { getAppContext } from "@/instrumentation";
import { getSession } from "@/lib/history";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = getAppContext();
  const { id } = await params;
  const mode = req.nextUrl.searchParams.get("mode") ?? "both";
  const session = getSession(ctx, id);
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (mode === "compressed") return NextResponse.json({ ...session, original: [] });
  if (mode === "original") return NextResponse.json({ ...session, compressed: [] });
  return NextResponse.json(session);
}
