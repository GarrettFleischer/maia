import { NextRequest, NextResponse } from "next/server";
import { searchAcrossSessions } from "@/lib/history";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const mode = (req.nextUrl.searchParams.get("mode") ?? "both") as "compressed" | "original" | "both";
  const tagsParam = req.nextUrl.searchParams.get("tags");
  const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  const results = searchAcrossSessions(q, mode, tags);
  return NextResponse.json({ results });
}
