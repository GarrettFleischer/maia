/**
 * @fileoverview API route to trigger an Ollama model pull (download) via the Ollama HTTP API.
 * @module app/api/ollama/pull/route
 *
 * POST /api/ollama/pull with JSON body { modelId: "ollama/llama3.2" }.
 * Proxies to Ollama's /api/pull with stream: false and returns { ok: true } on success.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { getSettings } from "@/lib/settings";

interface PullRequestBody {
  modelId?: unknown;
}

/**
 * POST /api/ollama/pull
 * @brief Starts an Ollama model pull for the given model id; returns when the pull completes.
 * @param req - NextRequest with JSON body { modelId: string } (e.g. "ollama/llama3.2").
 * @returns 200 with { ok: true } on success; 400 for invalid modelId; 502 when Ollama fails.
 * @note Uses stream: false so the handler waits for Ollama to finish the pull before responding.
 */
export async function POST(req: NextRequest) {
  let body: PullRequestBody;
  try {
    body = (await req.json()) as PullRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const modelId = body.modelId;
  if (typeof modelId !== "string" || modelId.trim() === "" || !modelId.startsWith("ollama/")) {
    return NextResponse.json(
      { error: "modelId must be a non-empty string starting with ollama/" },
      { status: 400 },
    );
  }

  const ctx = await ensureAppContext();
  const settings = getSettings(ctx);
  const baseUrl = (settings.ollamaBaseUrl ?? "").replace(/\/+$/, "");
  const pullUrl = `${baseUrl}/api/pull`;
  const modelName = modelId.replace(/^ollama\//, "");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.ollamaApiKey) {
    headers["Authorization"] = `Bearer ${settings.ollamaApiKey}`;
  }

  try {
    const resp = await ctx.http.fetch(pullUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: modelName, stream: false }),
    });
    if (!resp.ok) {
      return NextResponse.json(
        { error: "Failed to pull model" },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to pull model" },
      { status: 502 },
    );
  }
}
