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
 * @returns 200 with { ok: true } on success; 400 for invalid modelId or when Ollama reports a client-side error (e.g. invalid tag); 502 when Ollama or the network fails unexpectedly.
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
  if (
    typeof modelId !== "string" ||
    modelId.trim() === "" ||
    !modelId.startsWith("ollama/")
  ) {
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

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
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
      const errorText = (await resp.text().catch(() => "")) ?? "";

      let clientStatus = 502;
      let clientError = "Failed to pull model";
      let nestedStatus: number | undefined;

      if (errorText.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(errorText) as { error?: unknown };
          if (typeof parsed.error === "string" && parsed.error.trim() !== "") {
            clientError = parsed.error;
            const match = parsed.error.match(/\b(\d{3})\b/);
            if (match) {
              const code = Number.parseInt(match[1] ?? "", 10);
              if (Number.isFinite(code) && code >= 400 && code < 500) {
                nestedStatus = code;
              }
            }
          }
        } catch {
          // ignore JSON parse errors and fall back to generic message
        }
      }

      if (resp.status >= 400 && resp.status < 500) {
        clientStatus = resp.status;
      } else if (nestedStatus !== undefined) {
        clientStatus = nestedStatus;
      }

      return NextResponse.json(
        { error: clientError },
        { status: clientStatus },
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
