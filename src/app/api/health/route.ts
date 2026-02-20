/**
 * @fileoverview Health check API route for Maia.
 * @module app/api/health/route
 *
 * GET /api/health — returns 200 and { ok: true }. Requires MAIA_API_KEY Bearer.
 */

import { requireApiKey } from "@/lib/auth";
import { NextResponse } from "next/server";

/**
 * GET /api/health
 * @brief Returns a simple health payload. Requires Authorization: Bearer <MAIA_API_KEY>.
 * @returns 200 with JSON { ok: true } or 401 if unauthorized
 */
export async function GET(request: Request): Promise<NextResponse | Response> {
  const apiKey = process.env.MAIA_API_KEY ?? "";
  const authError = requireApiKey(request, apiKey);
  if (authError) return authError;
  return NextResponse.json({ ok: true }, { status: 200 });
}
