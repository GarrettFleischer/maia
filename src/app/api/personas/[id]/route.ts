/**
 * @fileoverview GET /api/personas/[id] — full persona template for one id.
 * @module app/api/personas/[id]/route
 *
 * @returns 200 JSON persona object; 404 when unknown id
 */
import { NextResponse } from "next/server";
import { getPersonaById } from "@/lib/personas/registry";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const persona = getPersonaById(decodeURIComponent(id));
  if (!persona) {
    return NextResponse.json({ error: "Unknown persona" }, { status: 404 });
  }
  return NextResponse.json({
    id: persona.id,
    name: persona.name,
    description: persona.description,
    instructions: persona.instructions,
    suggestedModelHint: persona.suggestedModelHint,
    suggestedReasoningEffort: persona.suggestedReasoningEffort,
    sandboxMode: persona.sandboxMode,
    sourcePath: persona.sourcePath,
  });
}
