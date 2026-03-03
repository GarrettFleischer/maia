/**
 * @fileoverview API route to list which Ollama models are downloaded (available locally).
 * @module app/api/ollama/models/route
 *
 * GET /api/ollama/models?modelIds=ollama/llama3.2,ollama/nomic-embed-text
 * Returns { downloaded: string[] } — subset of the requested model ids that exist on the Ollama server.
 * Non-Ollama ids are ignored. Used by the Settings page to show a "downloaded" indicator per model.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { getSettings } from "@/lib/settings";

interface OllamaTagModel {
  name?: string;
}

interface OllamaTagsResponse {
  models?: OllamaTagModel[];
}

/**
 * GET /api/ollama/models
 * @brief Returns which of the requested model ids are downloaded on the Ollama server.
 * @param req - NextRequest; query param modelIds (comma-separated) list of model ids (e.g. ollama/llama3.2).
 * @returns JSON { downloaded: string[] }. On Ollama unreachable, returns { downloaded: [] }.
 */
export async function GET(req: NextRequest) {
  const ctx = await ensureAppContext();
  const settings = getSettings(ctx);

  const modelIdsParam = req.nextUrl.searchParams.get("modelIds");
  const requestedIds = modelIdsParam
    ? modelIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const ollamaIds = requestedIds.filter((id) => id.startsWith("ollama/"));
  if (ollamaIds.length === 0) {
    return NextResponse.json(
      { downloaded: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const baseUrl = (settings.ollamaBaseUrl ?? "").replace(/\/+$/, "");
  const tagsUrl = `${baseUrl}/api/tags`;

  let tagNames: string[] = [];
  try {
    const headers: Record<string, string> = {};
    if (settings.ollamaApiKey) {
      headers["Authorization"] = `Bearer ${settings.ollamaApiKey}`;
    }
    const resp = await ctx.http.fetch(tagsUrl, { method: "GET", headers });
    if (!resp.ok) {
      return NextResponse.json(
        { downloaded: [] },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const raw = (await resp.json()) as OllamaTagsResponse;
    const models = Array.isArray(raw.models) ? raw.models : [];
    tagNames = models
      .map((m) => (typeof m.name === "string" ? m.name : ""))
      .filter(Boolean);
  } catch {
    return NextResponse.json(
      { downloaded: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const downloaded = ollamaIds.filter((id) => {
    const name = id.replace(/^ollama\//, "");
    return tagNames.some(
      (tag) => tag === name || tag.startsWith(name + ":"),
    );
  });

  return NextResponse.json(
    { downloaded },
    { headers: { "Cache-Control": "no-store" } },
  );
}
