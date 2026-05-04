/**
 * @fileoverview GET /api/personas — list bundled and data-dir persona templates.
 * @module app/api/personas/route
 *
 * @returns 200 JSON `{ personas: { id, name, description, suggestedModelHint?, sandboxMode? }[] }`
 */
import { NextResponse } from "next/server";
import { getPersonaCatalog } from "@/lib/personas/registry";

export async function GET() {
  const personas = getPersonaCatalog().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    suggestedModelHint: p.suggestedModelHint,
    sandboxMode: p.sandboxMode,
  }));
  return NextResponse.json({ personas });
}
