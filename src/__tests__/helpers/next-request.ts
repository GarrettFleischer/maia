/**
 * @fileoverview Test helper: create a Request that behaves like NextRequest (has nextUrl).
 * Used by API route tests so that req.nextUrl.searchParams works.
 * @module __tests__/helpers/next-request
 */
import type { NextRequest } from "next/server";

/**
 * Creates a request with nextUrl set so that route handlers can read search params.
 * @param urlStr - Full URL including optional query string
 * @param init - Optional RequestInit (method, headers, body)
 * @returns Request with nextUrl property set for Next.js route handlers
 */
export function createNextRequest(
  urlStr: string,
  init?: RequestInit
): NextRequest {
  const url = new URL(urlStr);
  const req = new Request(url, init) as NextRequest;
  Object.defineProperty(req, "nextUrl", { value: url, configurable: true });
  return req;
}
