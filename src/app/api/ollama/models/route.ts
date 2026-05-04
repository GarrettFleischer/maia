/**
 * @fileoverview API route to list Ollama models (all available or which of requested are downloaded).
 * @module app/api/ollama/models/route
 *
 * GET /api/ollama/models
 *   No query: returns { available: string[] } — model names (e.g. "llama3.2") from Ollama /api/tags.
 * GET /api/ollama/models?modelIds=ollama/llama3.2,ollama/nomic-embed-text
 *   Returns { downloaded: string[] } — subset of requested ids that exist on the Ollama server.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import type { HttpClient } from "@/lib/context";
import { getSettings } from "@/lib/settings";

interface OllamaTagModel {
  name?: string;
}

interface OllamaTagsResponse {
  models?: OllamaTagModel[];
}

/**
 * Fetches model tag names from Ollama /api/tags.
 * @returns Sorted list of model names (without "ollama/" prefix), or [] on failure.
 */
async function fetchOllamaTagNames(
  baseUrl: string,
  apiKey: string | undefined,
  http: HttpClient,
): Promise<string[]> {
  const tagsUrl = `${baseUrl}/api/tags`;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const resp = await http.fetch(tagsUrl, { method: "GET", headers });
  if (!resp.ok) return [];
  const raw = (await resp.json()) as OllamaTagsResponse;
  const models = Array.isArray(raw.models) ? raw.models : [];
  const names = models
    .map((m) => (typeof m.name === "string" ? m.name : ""))
    .filter(Boolean);
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * GET /api/ollama/models
 * @brief With no modelIds: returns { available: string[] }. With modelIds: returns { downloaded: string[] }.
 * @param req - NextRequest; optional query param modelIds (comma-separated) e.g. ollama/llama3.2.
 * @returns JSON { available?: string[] } or { downloaded: string[] }. On error, empty arrays.
 */
export async function GET(req: NextRequest) {
  const ctx = await ensureAppContext();
  const settings = getSettings(ctx);

  const modelIdsParam = req.nextUrl.searchParams.get("modelIds");
  const requestedIds = modelIdsParam
    ? modelIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const ollamaIds = requestedIds.filter((id) => id.startsWith("ollama/"));
  if (requestedIds.length > 0 && ollamaIds.length === 0) {
    return NextResponse.json(
      { downloaded: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const baseUrl = (settings.ollamaBaseUrl ?? "").replace(/\/+$/, "");
  const tagNames = baseUrl
    ? await fetchOllamaTagNames(
        baseUrl,
        settings.ollamaApiKey,
        ctx.http,
      )
    : [];

  if (requestedIds.length === 0) {
    return NextResponse.json(
      { available: tagNames },
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
