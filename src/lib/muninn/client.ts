/**
 * @fileoverview Thin REST client for MuninnDB (engrams, activate, search).
 * @module lib/muninn/client
 *
 * Uses the HTTP client adapter so it is testable with a fake. No @muninndb/client
 * dependency; implements POST /api/engrams, POST /api/activate, GET /api/engrams.
 */

import type { HttpClient } from "../context";

/** Single engram in ACTIVATE response. */
export interface ActivationItem {
  id: string;
  concept: string;
  content: string;
  score: number;
  confidence?: number;
  tags?: string[];
}

/** Response from POST /api/activate. */
export interface ActivateResponse {
  activations: ActivationItem[];
}

/** Single engram in search response (GET /api/engrams). */
export interface EngramListItem {
  id: string;
  concept: string;
  content: string;
  tags?: string[];
}

/** Response from GET /api/engrams (search). */
export interface SearchResponse {
  engrams: EngramListItem[];
}

/** Payload for a single engram in a batch request. */
export interface EngramBatchItem {
  vault: string;
  concept: string;
  content: string;
  tags?: string[];
}

/** Muninn client interface: write, batch write, activate, search. */
export interface MuninnClient {
  writeEngram(
    vault: string,
    concept: string,
    content: string,
    tags?: string[],
  ): Promise<{ id: string }>;
  /** Write up to 50 engrams in one request. Splits larger arrays into chunks. */
  writeEngramBatch(items: EngramBatchItem[]): Promise<{ written: number }>;
  activate(
    vault: string,
    context: string[],
    maxResults: number,
  ): Promise<ActivateResponse>;
  search(vault: string, q: string): Promise<SearchResponse>;
}

/**
 * Creates a Muninn REST client.
 * @param http - HTTP client (e.g. AppContext.http).
 * @param baseUrl - Muninn base URL (e.g. http://localhost:8475), no trailing slash.
 * @returns Client with writeEngram, activate, search.
 */
export function createMuninnClient(
  http: HttpClient,
  baseUrl: string,
): MuninnClient {
  const base = baseUrl.replace(/\/+$/, "");
  if (!base) {
    throw new Error("Muninn baseUrl is required");
  }

  return {
    async writeEngram(
      vault: string,
      concept: string,
      content: string,
      tags?: string[],
    ): Promise<{ id: string }> {
      const body: Record<string, unknown> = {
        vault,
        concept,
        content,
      };
      if (tags && tags.length > 0) body.tags = tags;
      const res = await http.fetch(`${base}/api/engrams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok) {
        throw new Error(
          data.error ?? `Muninn writeEngram failed: ${res.status}`,
        );
      }
      return { id: data.id ?? "" };
    },

    async writeEngramBatch(
      items: EngramBatchItem[],
    ): Promise<{ written: number }> {
      const BATCH_SIZE = 50;
      let written = 0;
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const chunk = items.slice(i, i + BATCH_SIZE);
        const body = { engrams: chunk };
        const res = await http.fetch(`${base}/api/engrams/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as { ids?: string[]; error?: string };
        if (!res.ok) {
          throw new Error(
            data.error ?? `Muninn writeEngramBatch failed: ${res.status}`,
          );
        }
        written += chunk.length;
      }
      return { written };
    },

    async activate(
      vault: string,
      context: string[],
      maxResults: number,
    ): Promise<ActivateResponse> {
      const res = await http.fetch(`${base}/api/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vault,
          context,
          max_results: maxResults,
        }),
      });
      const data = (await res.json()) as ActivateResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `Muninn activate failed: ${res.status}`);
      }
      return {
        activations: Array.isArray(data.activations) ? data.activations : [],
      };
    },

    async search(vault: string, q: string): Promise<SearchResponse> {
      const params = new URLSearchParams({ vault, q });
      const res = await http.fetch(`${base}/api/engrams?${params.toString()}`);
      const data = (await res.json()) as SearchResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `Muninn search failed: ${res.status}`);
      }
      return {
        engrams: Array.isArray(data.engrams) ? data.engrams : [],
      };
    },
  };
}
