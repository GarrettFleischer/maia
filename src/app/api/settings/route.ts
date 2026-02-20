/**
 * @fileoverview Settings API: read (heartbeat interval, etc.) from env.
 * @module app/api/settings/route
 *
 * GET /api/settings — 200 + { heartbeatIntervalMs?, ollamaBaseUrl?, defaultModel?, securityGateModel? }.
 */

import { requireApiKey } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function GET(request: Request): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  const heartbeatIntervalMs = process.env.MAIA_HEARTBEAT_INTERVAL_MS;
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const defaultModel = process.env.OLLAMA_DEFAULT_MODEL ?? "";
  const securityGateModel = process.env.OLLAMA_SECURITY_GATE_MODEL ?? "";
  return NextResponse.json({
    heartbeatIntervalMs: heartbeatIntervalMs ? parseInt(heartbeatIntervalMs, 10) : 60_000,
    ollamaBaseUrl,
    defaultModel,
    securityGateModel,
  });
}
