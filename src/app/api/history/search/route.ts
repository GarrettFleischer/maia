import { NextRequest, NextResponse } from "next/server";
import { getAppContext } from "@/instrumentation";
import { searchAcrossSessions } from "@/lib/history";

export async function GET(req: NextRequest) {
  const ctx = getAppContext();
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const mode = (req.nextUrl.searchParams.get("mode") ?? "both") as "compressed" | "original" | "both";
  const tagsParam = req.nextUrl.searchParams.get("tags");
  const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  const results = searchAcrossSessions(ctx, q, mode, tags);
  return NextResponse.json({ results });
}
